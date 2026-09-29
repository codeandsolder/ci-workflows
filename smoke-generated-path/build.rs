use std::{env, error::Error, fs, path::PathBuf};

fn main() -> Result<(), Box<dyn Error>> {
    let out_dir = env::var_os("OUT_DIR").ok_or("OUT_DIR is not set")?;
    let out_dir = PathBuf::from(out_dir);
    let asset = out_dir.join("asset.bin");
    fs::write(&asset, b"canonical-generated-path-smoke")?;

    let asset = asset
        .to_str()
        .ok_or("OUT_DIR asset path is not valid UTF-8")?;
    let generated = format!(
        "pub static GENERATED_ASSET: &[u8] = include_bytes!({asset:?});\n"
    );
    fs::write(out_dir.join("generated.rs"), generated)?;
    Ok(())
}
