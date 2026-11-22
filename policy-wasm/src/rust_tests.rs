//! Identify test-only Rust source ranges from compiler lexer tokens.
//! Literal contents and comments never contribute punctuation or attributes.
use ra_ap_rustc_lexer::{FrontmatterAllowed, TokenKind, tokenize};

#[derive(Clone, Copy)]
struct Token<'a> {
    kind: TokenKind,
    text: &'a str,
    first_line: usize,
    last_line: usize,
}

struct Tokens<'a> {
    tokens: Vec<Token<'a>>,
    closing: Vec<Option<usize>>,
}

impl<'a> Tokens<'a> {
    fn parse(source: &'a str) -> Option<Self> {
        let mut offset = 0;
        let mut line = 1;
        let mut tokens = Vec::new();
        let mut closing = Vec::new();
        let mut stack = Vec::new();
        for token in tokenize(source, FrontmatterAllowed::Yes) {
            let end = offset + usize::try_from(token.len).ok()?;
            let text = source.get(offset..end)?;
            offset = end;
            let first_line = line;
            line += memchr::memchr_iter(b'\n', text.as_bytes()).count();
            if matches!(
                token.kind,
                TokenKind::Whitespace
                    | TokenKind::LineComment { .. }
                    | TokenKind::BlockComment { .. }
                    | TokenKind::Frontmatter { .. }
            ) {
                continue;
            }
            let index = tokens.len();
            let expected_close = match token.kind {
                TokenKind::OpenBrace => Some(TokenKind::CloseBrace),
                TokenKind::OpenParen => Some(TokenKind::CloseParen),
                TokenKind::OpenBracket => Some(TokenKind::CloseBracket),
                _ => None,
            };
            if let Some(close) = expected_close {
                stack.push((index, close));
            } else if matches!(
                token.kind,
                TokenKind::CloseBrace | TokenKind::CloseParen | TokenKind::CloseBracket
            ) {
                let (begin, expected) = stack.pop()?;
                if expected != token.kind {
                    return None;
                }
                closing[begin] = Some(index);
            }
            tokens.push(Token {
                kind: token.kind,
                text,
                first_line,
                last_line: line,
            });
            closing.push(None);
        }
        if !stack.is_empty() {
            return None;
        }
        Some(Self { tokens, closing })
    }

    fn kind(&self, index: usize) -> Option<TokenKind> {
        self.tokens.get(index).map(|token| token.kind)
    }

    fn text(&self, index: usize) -> Option<&'a str> {
        self.tokens.get(index).map(|token| token.text)
    }

    fn close(&self, open: usize) -> Option<usize> {
        self.closing.get(open).copied().flatten()
    }

    fn attribute_end(&self, index: usize) -> Option<usize> {
        if self.kind(index) != Some(TokenKind::Pound)
            || self.kind(index + 1) != Some(TokenKind::OpenBracket)
        {
            return None;
        }
        self.close(index + 1)
    }

    fn test_attribute(&self, start: usize, end: usize) -> Option<TestAttribute> {
        let body = self.tokens.get(start + 2..end)?;
        if let [cfg, open, test, close] = body
            && [cfg.text, open.text, test.text, close.text] == ["cfg", "(", "test", ")"]
        {
            return Some(TestAttribute::TestOnlyModule);
        }
        let mut next = start + 2;
        if matches!(self.text(next), Some("tokio" | "async_std")) {
            if self.kind(next + 1) != Some(TokenKind::Colon)
                || self.kind(next + 2) != Some(TokenKind::Colon)
            {
                return None;
            }
            next += 3;
        }
        if self.text(next) != Some("test") {
            return None;
        }
        next += 1;
        if self.kind(next) == Some(TokenKind::OpenParen) {
            next = self.close(next)? + 1;
        }
        (next == end).then_some(TestAttribute::TestFunction)
    }

    fn after_attributes(&self, mut index: usize) -> usize {
        while let Some(end) = self.attribute_end(index) {
            index = end + 1;
        }
        index
    }

    fn after_visibility(&self, mut index: usize) -> Option<usize> {
        if self.text(index) == Some("pub") {
            index += 1;
            if self.kind(index) == Some(TokenKind::OpenParen) {
                index = self.close(index)? + 1;
            }
        }
        Some(index)
    }

    fn item_body(&self, mut index: usize, attribute: TestAttribute) -> Option<usize> {
        match attribute {
            TestAttribute::TestOnlyModule => {
                if self.text(index) == Some("mod")
                    && matches!(
                        self.kind(index + 1),
                        Some(TokenKind::Ident | TokenKind::RawIdent)
                    )
                    && self.kind(index + 2) == Some(TokenKind::OpenBrace)
                {
                    return Some(index + 2);
                }
                None
            }
            TestAttribute::TestFunction => {
                while matches!(self.text(index), Some("async" | "unsafe" | "const")) {
                    index += 1;
                }
                if self.text(index) != Some("fn")
                    || !matches!(
                        self.kind(index + 1),
                        Some(TokenKind::Ident | TokenKind::RawIdent)
                    )
                {
                    return None;
                }
                self.function_body(index + 2)
            }
        }
    }

    // Parenthesized or bracketed expressions and const generic braces in
    // signatures are not the function body. Skip whole balanced token trees.
    fn function_body(&self, mut index: usize) -> Option<usize> {
        let mut angles = 0usize;
        while let Some(kind) = self.kind(index) {
            match kind {
                TokenKind::Lt => angles += 1,
                TokenKind::Gt => angles = angles.saturating_sub(1),
                TokenKind::OpenBrace if angles == 0 => return Some(index),
                TokenKind::OpenParen | TokenKind::OpenBracket | TokenKind::OpenBrace => {
                    index = self.close(index)?;
                }
                TokenKind::Semi | TokenKind::CloseBrace => return None,
                _ => (),
            }
            index += 1;
        }
        None
    }

    fn test_ranges(&self) -> Vec<(usize, usize)> {
        let mut ranges = Vec::new();
        for (index, token) in self.tokens.iter().enumerate() {
            let Some(end) = self.attribute_end(index) else {
                continue;
            };
            let Some(attribute) = self.test_attribute(index, end) else {
                continue;
            };
            let Some(item) = self.after_visibility(self.after_attributes(end + 1)) else {
                continue;
            };
            let Some(close) = self
                .item_body(item, attribute)
                .and_then(|body| self.close(body))
            else {
                continue;
            };
            ranges.push((token.first_line, self.tokens[close].last_line));
        }
        // Attribute nesting produces contained ranges. The maximal range is
        // sufficient for each contained source line, without merging adjacent
        // unrelated items into a synthetic test scope.
        let mut maximal = Vec::<(usize, usize)>::new();
        for range in ranges {
            if maximal.last().is_none_or(|last| last.1 < range.1) {
                maximal.push(range);
            }
        }
        maximal
    }
}

#[derive(Clone, Copy)]
enum TestAttribute {
    TestOnlyModule,
    TestFunction,
}

pub fn test_ranges(source: &str) -> Vec<(usize, usize)> {
    if memchr::memchr(b'#', source.as_bytes()).is_none() || !source.contains("test") {
        return Vec::new();
    }
    Tokens::parse(source).map_or_else(Vec::new, |tokens| tokens.test_ranges())
}

pub fn contains(ranges: &[(usize, usize)], start: usize, end: usize) -> bool {
    ranges
        .partition_point(|range| range.0 <= start)
        .checked_sub(1)
        .is_some_and(|index| start <= end && end <= ranges[index].1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structural_test_ranges() {
        let source = concat!(
            "const TEXT: &str = r###\"#[cfg(test)] mod fake {}\"###;\n",
            "const C: &core::ffi::CStr = cr#\"} #[test] fn fake() {}\"#;\n",
            "/* outer /* nested { */ } */\n",
            "#[cfg(test)]\n#[allow(dead_code)]\nmod tests {\n",
            "    fn helper() { let _ = '}'; }\n",
            "}\n#[tokio::test(flavor = \"current_thread\")]\n",
            "async fn test() { let _ = \"{\"; }\n",
            "fn prod() {}\n",
        );
        assert_eq!(test_ranges(source), [(4, 8), (9, 10)]);
        let ranges = test_ranges(source);
        assert!(contains(&ranges, 7, 8));
        assert!(!contains(&ranges, 8, 9));
        assert!(!contains(&ranges, 11, 11));
    }

    #[test]
    fn generic_signature_braces_are_not_body() {
        let source = "#[test]\nfn x<T: Trait<{ 1 + 2 }>>() {\n    run();\n}\nfn prod() {}";
        assert_eq!(test_ranges(source), [(1, 4)]);
        assert!(test_ranges("#[test] fn x() {").is_empty());
    }
}
