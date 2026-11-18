fn main() {
    println!("cargo:rerun-if-changed=../ui-dist");
    println!("cargo:rerun-if-changed=../ui-dist/index.html");
    println!("cargo:rerun-if-changed=../ui-dist/version.json");
    println!("cargo:rerun-if-changed=../ui-dist/src");
    println!("cargo:rerun-if-changed=../ui-dist/public");
    tauri_build::build()
}
