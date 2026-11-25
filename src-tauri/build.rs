fn main() {
    #[cfg(feature = "desktop")]
    {
        println!("cargo:rerun-if-changed=../public");
        tauri_build::build();
    }
}
