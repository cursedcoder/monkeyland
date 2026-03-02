/// Starts a local HTTP proxy on a random port that forwards all requests to
/// `target_base`, injecting CORS headers so the Tauri WebView can reach APIs
/// that don't allow browser origins (e.g. api.kilo.ai).
use axum::{
    body::Body,
    extract::{Request, State},
    http::HeaderValue,
    response::Response,
    routing::any,
    Router,
};
use reqwest::Client;
use std::sync::Arc;
use tokio::net::TcpListener;

#[derive(Clone)]
struct ProxyState {
    client: Client,
    target_base: String,
}

async fn handle(State(state): State<Arc<ProxyState>>, req: Request) -> Response {
    // Handle CORS preflight
    if req.method() == axum::http::Method::OPTIONS {
        return Response::builder()
            .status(204)
            .header("access-control-allow-origin", "*")
            .header("access-control-allow-methods", "*")
            .header("access-control-allow-headers", "*")
            .body(Body::empty())
            .unwrap();
    }

    let path = req
        .uri()
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or("/");
    let target_url = format!("{}{}", state.target_base, path);

    let method: reqwest::Method = match req.method().as_str().parse() {
        Ok(m) => m,
        Err(_) => return error_response("Invalid method"),
    };

    let mut fwd_headers = reqwest::header::HeaderMap::new();
    for (k, v) in req.headers() {
        // Drop hop-by-hop and browser-identifying headers
        if matches!(
            k.as_str(),
            "host" | "connection" | "transfer-encoding" | "origin" | "referer"
        ) {
            continue;
        }
        if let (Ok(k2), Ok(v2)) = (
            reqwest::header::HeaderName::from_bytes(k.as_str().as_bytes()),
            reqwest::header::HeaderValue::from_bytes(v.as_bytes()),
        ) {
            fwd_headers.insert(k2, v2);
        }
    }

    let body_bytes = match axum::body::to_bytes(req.into_body(), 32 * 1024 * 1024).await {
        Ok(b) => b,
        Err(_) => return error_response("Failed to read request body"),
    };

    let resp = match state
        .client
        .request(method, &target_url)
        .headers(fwd_headers)
        .body(body_bytes)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return error_response(&e.to_string()),
    };

    let status = axum::http::StatusCode::from_u16(resp.status().as_u16())
        .unwrap_or(axum::http::StatusCode::INTERNAL_SERVER_ERROR);
    let resp_headers = resp.headers().clone();
    let stream = resp.bytes_stream();

    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = status;

    for (k, v) in &resp_headers {
        if let (Ok(k2), Ok(v2)) = (
            axum::http::HeaderName::from_bytes(k.as_str().as_bytes()),
            axum::http::HeaderValue::from_bytes(v.as_bytes()),
        ) {
            response.headers_mut().insert(k2, v2);
        }
    }

    // Inject CORS headers so the WebView can consume the response
    response
        .headers_mut()
        .insert("access-control-allow-origin", HeaderValue::from_static("*"));
    response.headers_mut().insert(
        "access-control-allow-headers",
        HeaderValue::from_static("*"),
    );
    response.headers_mut().insert(
        "access-control-allow-methods",
        HeaderValue::from_static("*"),
    );

    response
}

fn error_response(msg: &str) -> Response {
    Response::builder()
        .status(500)
        .header("access-control-allow-origin", "*")
        .body(Body::from(msg.to_string()))
        .unwrap()
}

pub async fn start(target_base: String) -> Result<u16, String> {
    let state = Arc::new(ProxyState {
        client: Client::new(),
        target_base,
    });

    let app = Router::new()
        .route("/", any(handle))
        .route("/*path", any(handle))
        .with_state(state);

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });

    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::get;

    async fn start_mock_upstream() -> u16 {
        let app = Router::new()
            .route(
                "/test",
                get(|| async { axum::Json(serde_json::json!({"ok": true})) }),
            )
            .route(
                "/echo-status",
                get(|| async {
                    Response::builder()
                        .status(201)
                        .header("x-custom", "upstream-header")
                        .body(Body::from("created"))
                        .unwrap()
                }),
            );

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            axum::serve(listener, app).await.ok();
        });
        port
    }

    #[tokio::test]
    async fn proxy_starts_and_returns_port() {
        let upstream_port = start_mock_upstream().await;
        let port = start(format!("http://127.0.0.1:{upstream_port}"))
            .await
            .unwrap();
        assert!(port > 0);
    }

    #[tokio::test]
    async fn proxy_forwards_get_with_cors() {
        let upstream_port = start_mock_upstream().await;
        let proxy_port = start(format!("http://127.0.0.1:{upstream_port}"))
            .await
            .unwrap();

        let client = reqwest::Client::new();
        let resp = client
            .get(format!("http://127.0.0.1:{proxy_port}/test"))
            .send()
            .await
            .unwrap();

        assert_eq!(resp.status(), 200);
        assert_eq!(
            resp.headers()
                .get("access-control-allow-origin")
                .unwrap()
                .to_str()
                .unwrap(),
            "*"
        );
        let body: serde_json::Value = resp.json().await.unwrap();
        assert_eq!(body["ok"], true);
    }

    #[tokio::test]
    async fn proxy_preserves_upstream_status_code() {
        let upstream_port = start_mock_upstream().await;
        let proxy_port = start(format!("http://127.0.0.1:{upstream_port}"))
            .await
            .unwrap();

        let client = reqwest::Client::new();
        let resp = client
            .get(format!("http://127.0.0.1:{proxy_port}/echo-status"))
            .send()
            .await
            .unwrap();

        assert_eq!(
            resp.status(),
            201,
            "proxy should preserve upstream status code"
        );
    }

    #[tokio::test]
    async fn proxy_options_preflight() {
        let upstream_port = start_mock_upstream().await;
        let proxy_port = start(format!("http://127.0.0.1:{upstream_port}"))
            .await
            .unwrap();

        let client = reqwest::Client::new();
        let resp = client
            .request(
                reqwest::Method::OPTIONS,
                format!("http://127.0.0.1:{proxy_port}/test"),
            )
            .send()
            .await
            .unwrap();

        assert_eq!(resp.status(), 204);
        assert_eq!(
            resp.headers()
                .get("access-control-allow-origin")
                .unwrap()
                .to_str()
                .unwrap(),
            "*"
        );
        assert_eq!(
            resp.headers()
                .get("access-control-allow-methods")
                .unwrap()
                .to_str()
                .unwrap(),
            "*"
        );
    }

    #[tokio::test]
    async fn proxy_unreachable_target_returns_500() {
        let proxy_port = start("http://127.0.0.1:19999".to_string()).await.unwrap();

        let client = reqwest::Client::new();
        let resp = client
            .get(format!("http://127.0.0.1:{proxy_port}/test"))
            .send()
            .await
            .unwrap();

        assert_eq!(resp.status(), 500);
        assert_eq!(
            resp.headers()
                .get("access-control-allow-origin")
                .unwrap()
                .to_str()
                .unwrap(),
            "*"
        );
    }
}
