use saphyr::{Yaml, YamlLoader};
use saphyr_parser::Parser;

pub type Node<'a> = Yaml<'a>;

pub fn parse(source: &str) -> Result<Node<'_>, String> {
    // Use the YAML representation rather than coercing scalars to integers or
    // booleans. Actions' on key, expressions and runner labels are strings.
    let mut parser = Parser::new_from_str(source);
    let mut loader = YamlLoader::<Node<'_>>::default();
    loader.early_parse(false);
    parser
        .load(&mut loader, true)
        .map_err(|error| error.to_string())?;
    if let Some(error) = loader.error() {
        return Err(error.to_string());
    }
    let mut documents = loader.into_documents().into_iter();
    let document = documents
        .next()
        .ok_or_else(|| "expected YAML mapping".to_owned())?;
    if documents.next().is_some() {
        return Err("multiple YAML documents".into());
    }
    Ok(document)
}

pub fn scalar<'node>(node: &'node Node<'_>) -> Option<&'node str> {
    if let Yaml::Representation(value, _, _) = node {
        Some(value.as_ref())
    } else {
        node.as_str()
    }
}

pub fn get<'node, 'source>(node: &'node Node<'source>, key: &str) -> Option<&'node Node<'source>> {
    node.as_mapping()?
        .iter()
        .rev()
        .find_map(|(name, value)| (scalar(name) == Some(key)).then_some(value))
}

pub fn field<'node>(node: &'node Node<'_>, key: &str) -> Option<&'node str> {
    get(node, key).and_then(scalar)
}

pub fn strings<'node>(node: &'node Node<'_>, out: &mut Vec<&'node str>) {
    if let Some(value) = scalar(node) {
        out.push(value);
    } else if let Some(sequence) = node.as_vec() {
        for item in sequence {
            strings(item, out);
        }
    } else if let Some(mapping) = node.as_mapping() {
        for value in mapping.values() {
            strings(value, out);
        }
    }
}

pub fn fields<'node>(node: &'node Node<'_>, keys: &[&str], out: &mut Vec<&'node str>) {
    for key in keys {
        if let Some(value) = get(node, key) {
            strings(value, out);
        }
    }
}

fn merge_key(key: &Node<'_>) -> bool {
    match key {
        Node::Representation(value, style, tag) => tag.as_ref().map_or_else(
            || *style == saphyr::ScalarStyle::Plain && value == "<<",
            |tag| tag.handle == "tag:yaml.org,2002" && tag.suffix == "merge",
        ),
        _ => false,
    }
}

fn normalize_key(key: Node<'_>) -> Node<'_> {
    match key {
        Node::Representation(value, _, _) => Node::Value(saphyr::Scalar::String(value)),
        key => key,
    }
}

fn inherit<'a>(out: &mut saphyr::Mapping<'a>, value: Node<'a>) -> Result<(), String> {
    let Node::Mapping(mapping) = value else {
        return Err("YAML merge value must be a mapping".into());
    };
    for (key, value) in mapping {
        out.insert(key, value);
    }
    Ok(())
}

// The cache policy historically uses YAML SafeLoader (including merges),
// whereas the concurrency checker uses BaseLoader. Keep that distinction.
fn merge_node(node: Node<'_>) -> Result<Node<'_>, String> {
    match node {
        Node::Mapping(mapping) => {
            let mut inherited = saphyr::Mapping::new();
            let mut explicit = Vec::with_capacity(mapping.len());
            for (key, value) in mapping {
                let value = merge_node(value)?;
                if merge_key(&key) {
                    if let Node::Sequence(mappings) = value {
                        for mapping in mappings {
                            inherit(&mut inherited, mapping)?;
                        }
                    } else {
                        inherit(&mut inherited, value)?;
                    }
                } else {
                    explicit.push((normalize_key(key), value));
                }
            }
            inherited.extend(explicit);
            Ok(Node::Mapping(inherited))
        }
        Node::Sequence(sequence) => sequence
            .into_iter()
            .map(merge_node)
            .collect::<Result<Vec<_>, _>>()
            .map(Node::Sequence),
        node => Ok(node),
    }
}

pub fn parse_with_merges(source: &str) -> Result<Node<'_>, String> {
    merge_node(parse(source)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actions_scalars_and_anchors() -> Result<(), String> {
        let source = "on: [pull_request]\nrunner: &runner [self-hosted, Linux]\njob:\n  runs-on: *runner\n  cancel: true\n";
        let doc = parse(source)?;
        assert!(get(&doc, "on").is_some());
        let job = get(&doc, "job").ok_or("missing job")?;
        assert_eq!(field(job, "cancel"), Some("true"));
        let mut values = Vec::new();
        fields(job, &["runs-on"], &mut values);
        assert_eq!(values, ["self-hosted", "Linux"]);
        Ok(())
    }
}
