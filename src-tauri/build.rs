fn main() {
    // Sem isto o Cargo reaproveita o recurso antigo e o .exe continua com o ícone anterior
    // depois de `npm run icon`.
    println!("cargo:rerun-if-changed=icons");

    // Cliente OAuth do Google Drive: lido de google.secret.json (fora do git) e embutido no build.
    // Formato: { "client_id": "...apps.googleusercontent.com", "client_secret": "..." }
    println!("cargo:rerun-if-changed=google.secret.json");
    if let Ok(text) = std::fs::read_to_string("google.secret.json") {
        let field = |name: &str| -> Option<String> {
            let key = format!("\"{name}\"");
            let rest = &text[text.find(&key)? + key.len()..];
            let start = rest.find('"')? + 1;
            let end = start + rest[start..].find('"')?;
            Some(rest[start..end].to_string())
        };
        if let (Some(id), Some(secret)) = (field("client_id"), field("client_secret")) {
            println!("cargo:rustc-env=NOTEX_GOOGLE_CLIENT_ID={id}");
            println!("cargo:rustc-env=NOTEX_GOOGLE_CLIENT_SECRET={secret}");
        }
    }

    tauri_build::build()
}
