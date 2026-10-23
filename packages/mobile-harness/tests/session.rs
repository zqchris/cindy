//! Tier 1: real persisted kernel commands; fake model responses only.
//! Covers approval, cancellation, recovery and capability escape failures.
use cindy_mobile_harness::{invoke, types::Command};
use serde_json::{Value, json};
use std::path::Path;
fn call(root: &Path, value: Value) -> Value {
    invoke(root, serde_json::from_value::<Command>(value).unwrap()).unwrap()
}
fn model() -> Value {
    json!({"provider":"test","model":"fixture","protocol":"openai","context_bytes":48000})
}
fn start(root: &Path, extra: Value) -> Value {
    let s = call(root, json!({"op":"create","title":"Work","model":model()}));
    call(
        root,
        json!({"op":"submit","id":s["id"],"text":"Create a page","model":model(),"tools":extra}),
    )
}
fn response(root: &Path, s: &Value, name: &str, arguments: Value) -> Value {
    call(
        root,
        json!({"op":"model_result","id":s["id"],"effect_id":s["effect"]["id"],"response":{"choices":[{"message":{"content":"Working","tool_calls":[{"id":"call-1","function":{"name":name,"arguments":arguments.to_string()}}]}}]}}),
    )
}
#[test]
fn approval_write_and_reopen_keep_real_files_and_history() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let s = start(root, json!([]));
    let s = response(
        root,
        &s,
        "write",
        json!({"path":"pages/index.html","content":"<h1>Hello</h1>"}),
    );
    assert_eq!(s["status"], "approval");
    assert!(
        !root
            .join("workspaces")
            .join(s["id"].as_str().unwrap())
            .join("pages/index.html")
            .exists()
    );
    let s = call(
        root,
        json!({"op":"approve","id":s["id"],"effect_id":s["effect"]["id"],"allow":true}),
    );
    let s = call(
        root,
        json!({"op":"execute","id":s["id"],"effect_id":s["effect"]["id"]}),
    );
    assert_eq!(
        call(
            root,
            json!({"op":"read_file","id":s["id"],"path":"pages/index.html"})
        ),
        "<h1>Hello</h1>"
    );
    assert_eq!(
        call(root, json!({"op":"load","id":s["id"]}))["messages"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    let listing = call(root, json!({"op":"files","id":s["id"],"path":"pages"}));
    assert!(listing.as_str().unwrap().contains("index.html"));
}
#[test]
fn cancellation_rejects_late_model_results_and_preserves_input() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let s = start(root, json!([]));
    call(root, json!({"op":"cancel","id":s["id"]}));
    let stale: Command = serde_json::from_value(
        json!({"op":"model_result","id":s["id"],"effect_id":s["effect"]["id"],"response":{}}),
    )
    .unwrap();
    assert_eq!(invoke(root, stale).unwrap_err().to_string(), "STALE_EFFECT");
    let s = call(root, json!({"op":"load","id":s["id"]}));
    assert_eq!(s["messages"][0]["text"], "Create a page");
}
#[test]
fn extension_claim_is_durable_and_cannot_be_replayed_after_crash() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let tools = json!([{"name":"send_mail","description":"Send email","parameters":{"type":"object"},"source":"mail","revision":"sha1","writes":true}]);
    let s = start(root, tools);
    let s = response(root, &s, "send_mail", json!({}));
    let s = call(
        root,
        json!({"op":"approve","id":s["id"],"effect_id":s["effect"]["id"],"allow":true}),
    );
    let claim = json!({"op":"claim_tool","id":s["id"],"effect_id":s["effect"]["id"]});
    call(root, claim.clone());
    assert_eq!(
        invoke(root, serde_json::from_value(claim).unwrap())
            .unwrap_err()
            .to_string(),
        "EXECUTION_UNCERTAIN"
    );
    let s = call(root, json!({"op":"recover","id":s["id"]}));
    assert_eq!(s["status"], "interrupted");
    assert!(s["effect"].is_null());
    assert!(
        s["messages"][2]["text"]
            .as_str()
            .unwrap()
            .contains("may or may not")
    );
}
#[test]
fn declined_write_does_not_mutate_workspace() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let s = start(root, json!([]));
    let s = response(
        root,
        &s,
        "write",
        json!({"path":"private.txt","content":"no"}),
    );
    let s = call(
        root,
        json!({"op":"approve","id":s["id"],"effect_id":s["effect"]["id"],"allow":false}),
    );
    assert_eq!(s["messages"][2]["is_error"], true);
    assert!(
        !root
            .join("workspaces")
            .join(s["id"].as_str().unwrap())
            .join("private.txt")
            .exists()
    );
}
#[cfg(unix)]
#[test]
fn workspace_rejects_parent_paths_and_symlink_escape() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let s = start(root, json!([]));
    let workspace = root.join("workspaces").join(s["id"].as_str().unwrap());
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret"), "private").unwrap();
    std::os::unix::fs::symlink(outside.path(), workspace.join("escape")).unwrap();
    for path in ["../secret", "/etc/passwd", "escape/secret"] {
        assert!(
            invoke(
                root,
                serde_json::from_value(json!({"op":"read_file","id":s["id"],"path":path})).unwrap()
            )
            .is_err()
        );
    }
}
#[test]
fn protocol_adapters_preserve_tool_requests() {
    for (protocol, response) in [
        (
            "anthropic",
            json!({"content":[{"type":"tool_use","id":"a","name":"list","input":{}}]}),
        ),
        (
            "google",
            json!({"candidates":[{"content":{"parts":[{"functionCall":{"name":"list","args":{}}}]}}]}),
        ),
        (
            "apple",
            json!({"text":"","calls":[{"id":"a","name":"list","arguments":{}}]}),
        ),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let mut model = model();
        model["protocol"] = json!(protocol);
        let s = call(
            root,
            json!({"op":"create","title":"Protocol","model":model}),
        );
        let s = call(
            root,
            json!({"op":"submit","id":s["id"],"text":"List files","model":model}),
        );
        let s = call(
            root,
            json!({"op":"model_result","id":s["id"],"effect_id":s["effect"]["id"],"response":response}),
        );
        assert_eq!(s["effect"]["kind"], "tool");
        assert_eq!(s["effect"]["call"]["name"], "list");
    }
}

// Regression: Gemini rejects continuations if signed parts are reconstructed.
#[test]
fn google_signed_parts_survive_persistence_and_tool_execution() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let mut model = model();
    model["protocol"] = json!("google");
    let s = call(root, json!({"op":"create","title":"Signed","model":model}));
    let s = call(
        root,
        json!({"op":"submit","id":s["id"],"text":"List files","model":model}),
    );
    let parts =
        json!([{"functionCall":{"name":"list","args":{}},"thoughtSignature":"opaque-signature"}]);
    let s = call(
        root,
        json!({"op":"model_result","id":s["id"],"effect_id":s["effect"]["id"],"response":{"candidates":[{"content":{"parts":parts}}]}}),
    );
    let s = call(root, json!({"op":"load","id":s["id"]}));
    let s = call(
        root,
        json!({"op":"execute","id":s["id"],"effect_id":s["effect"]["id"]}),
    );
    assert_eq!(s["effect"]["body"]["contents"][1]["parts"], parts);
}

// Regression: compaction must retain full disk history and the newest request,
// and must not submit a request larger than its configured context budget.
#[test]
fn compaction_keeps_history_and_continues_with_latest_input() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let mut model = model();
    model["context_bytes"] = json!(8000);
    let s = call(root, json!({"op":"create","title":"Compact","model":model}));
    let s = call(
        root,
        json!({"op":"submit","id":s["id"],"text":"a".repeat(2500),"model":model}),
    );
    let s = call(
        root,
        json!({"op":"model_result","id":s["id"],"effect_id":s["effect"]["id"],"response":{"choices":[{"message":{"content":"b".repeat(1800)}}]}}),
    );
    let latest = "c".repeat(2800);
    let s = call(
        root,
        json!({"op":"submit","id":s["id"],"text":latest,"model":model}),
    );
    assert_eq!(s["effect"]["compact"], true);
    assert!(serde_json::to_vec(&s["effect"]["body"]).unwrap().len() <= 8000);
    let s = call(
        root,
        json!({"op":"model_result","id":s["id"],"effect_id":s["effect"]["id"],"response":{"choices":[{"message":{"content":"Previous work summary"}}]}}),
    );
    assert_eq!(s["effect"]["compact"], false);
    assert_eq!(s["messages"].as_array().unwrap().len(), 3);
    assert_eq!(s["effect"]["body"]["messages"][1]["content"], latest);
    assert!(serde_json::to_vec(&s["effect"]["body"]).unwrap().len() <= 8000);
}

// Durable delivery must not append a second input when the phone retries after
// losing the response to create/submit. This goes through the persisted API.
#[test]
fn creation_and_input_are_idempotent_across_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let create = json!({"op":"create","id":id,"title":"Once","model":model()});
    call(temp.path(), create.clone());
    let submit =
        json!({"op":"submit","id":id,"client_id":"input-1","text":"Hello","model":model()});
    let first = call(temp.path(), submit.clone());
    assert_eq!(call(temp.path(), create)["messages"], first["messages"]);
    assert_eq!(call(temp.path(), submit)["effect"], first["effect"]);
    assert_eq!(first["messages"].as_array().unwrap().len(), 1);
    assert!(first["messages"][0]["created_at"].as_u64().unwrap() > 0);
}

// Stateless Responses needs the encrypted reasoning and exact call identity on
// the next request, including after a disk round trip and a local tool result.
#[test]
fn responses_replays_reasoning_and_namespaced_tool_call() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let mut m = model();
    m["protocol"] = json!("responses");
    let s = call(root, json!({"op":"create","title":"Responses","model":m}));
    let s = call(
        root,
        json!({"op":"submit","id":s["id"],"text":"List files","model":m}),
    );
    assert_eq!(s["effect"]["body"]["store"], false);
    assert_eq!(s["effect"]["body"]["tools"][0]["type"], "namespace");
    let output = json!([
        {"type":"reasoning","id":"rs1","encrypted_content":"opaque","summary":[]},
        {"type":"function_call","id":"fc1","call_id":"call1","namespace":"cindy","name":"list","arguments":"{\"path\":\".\"}"}
    ]);
    let s = call(
        root,
        json!({"op":"model_result","id":s["id"],"effect_id":s["effect"]["id"],"response":{"output":output}}),
    );
    let s = call(
        root,
        json!({"op":"execute","id":s["id"],"effect_id":s["effect"]["id"]}),
    );
    let saved = call(root, json!({"op":"load","id":s["id"]}));
    let input = saved["effect"]["body"]["input"].as_array().unwrap();
    assert_eq!(input[1], output[0]);
    assert_eq!(input[2], output[1]);
    assert_eq!(input[3]["type"], "function_call_output");
    assert_eq!(input[3]["call_id"], "call1");
}
