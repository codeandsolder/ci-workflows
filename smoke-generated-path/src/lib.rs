#![forbid(unsafe_code)]

include!(concat!(env!("OUT_DIR"), "/generated.rs"));

#[cfg(test)]
mod tests {
    use super::GENERATED_ASSET;

    #[test]
    fn generated_absolute_out_dir_path_resolves() {
        assert_eq!(GENERATED_ASSET, b"canonical-generated-path-smoke");
    }
}
