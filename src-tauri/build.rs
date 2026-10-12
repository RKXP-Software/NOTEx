fn main() {
    // Sem isto o Cargo reaproveita o recurso antigo e o .exe continua com o ícone anterior
    // depois de `npm run icon`.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
