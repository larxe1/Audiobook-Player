fn main() {
    println!("cargo:rerun-if-changed=../ui-dist");
    println!("cargo:rerun-if-changed=../ui-dist/index.html");
    println!("cargo:rerun-if-changed=../ui-dist/version.json");
    println!("cargo:rerun-if-changed=../ui-dist/src");
    println!("cargo:rerun-if-changed=../ui-dist/public");
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    tauri_build::build()
}
