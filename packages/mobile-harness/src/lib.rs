//! Host-driven agent kernel. Each command commits before returning an effect.
//! Hosts own transport, credentials and extension execution; this crate owns
//! session state, protocol normalization, authorization and workspace access.
mod ffi;
pub mod models;
mod store;
pub mod tools;
pub mod types;

use serde_json::{Value, json};
use std::{path::Path, sync::Mutex};
use store::Store;
use types::*;
pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
static SERIAL: Mutex<()> = Mutex::new(());

pub fn invoke(root: &Path, command: Command) -> Result<Value> {
    let _guard = SERIAL.lock().map_err(|_| "KERNEL_UNAVAILABLE")?;
    let store = Store::new(root)?;
    match command {
        Command::Create {id, title, model} => {
            let id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            Store::validate_id(&id)?;
            if let Some(existing) = store.find(&id)? { return Ok(serde_json::to_value(existing)?); }
            validate_model(&model)?;
            let s = Session {created_at:now(),updated_at:now(),metadata:serde_json::Map::new(),version:1,id,title:title.chars().take(120).collect(),model,messages:vec![],status:"idle".into(),effect:None,tools:tools::descriptors(),pending_calls:vec![],summary:String::new(),context_start:0,compact_end:0,steps:0,error:None};
            store.workspace(&s.id)?;
            store.save(&s)?;
            return Ok(serde_json::to_value(s)?);
        }
        Command::List => return Ok(json!(store.list()?.into_iter().map(|s|json!({"id":s.id,"title":s.title,"status":s.status,"model":s.model,"messages":s.messages.len(),"created_at":s.created_at,"updated_at":s.updated_at,"metadata":s.metadata})).collect::<Vec<_>>())),
        Command::Files {id,path} => return Ok(json!(tools::execute(&store.workspace(&id)?,&ToolCall{id:String::new(),name:"list".into(),arguments:json!({"path":if path.is_empty(){"."}else{&path}})})?)),
        Command::ReadFile {id,path} => return Ok(json!(tools::execute(&store.workspace(&id)?,&ToolCall{id:String::new(),name:"read".into(),arguments:json!({"path":path})})?)),
        _ => {},
    }
    let id = match &command {
        Command::Load { id }
        | Command::Update { id, .. }
        | Command::Submit { id, .. }
        | Command::ModelResult { id, .. }
        | Command::Approve { id, .. }
        | Command::Execute { id, .. }
        | Command::ClaimTool { id, .. }
        | Command::ExtensionFile { id, .. }
        | Command::ToolResult { id, .. }
        | Command::Fail { id, .. }
        | Command::Cancel { id }
        | Command::Recover { id }
        | Command::Resume { id, .. } => id,
        _ => unreachable!(),
    };
    let mut s = store.load(id)?;
    match command {
        Command::Load { .. } => return Ok(serde_json::to_value(s)?),
        Command::Update {
            title,
            model,
            metadata,
            ..
        } => {
            s.metadata.extend(metadata);
            if let Some(title) = title {
                s.title = title.chars().take(120).collect();
            }
            if let Some(model) = model {
                if s.effect.is_some() {
                    return Err("SESSION_BUSY".into());
                }
                validate_model(&model)?;
                s.model = model;
            }
        }
        Command::Submit {
            text,
            model,
            tools,
            client_id,
            ..
        } => {
            if client_id
                .as_ref()
                .is_some_and(|id| s.messages.iter().any(|m| m.client_id.as_ref() == Some(id)))
            {
                return Ok(serde_json::to_value(s)?);
            }
            if s.effect.is_some() || s.status == "running" {
                return Err("SESSION_BUSY".into());
            }
            if text.trim().is_empty() || text.len() > 256_000 {
                return Err("INVALID_INPUT".into());
            }
            validate_model(&model)?;
            s.tools = registry(tools)?;
            s.model = model;
            let mut message = Message::text("user", text);
            message.client_id = client_id;
            s.messages.push(message);
            s.steps = 0;
            s.error = None;
            schedule_model(&mut s)?;
        }
        Command::ModelResult {
            effect_id,
            response,
            ..
        } => {
            let compact = match checked_effect(&s, &effect_id)? {
                Effect::Model { compact, .. } => *compact,
                _ => return Err("WRONG_EFFECT".into()),
            };
            let m = models::parse(s.model.protocol, response)?;
            s.effect = None;
            if compact {
                if !m.calls.is_empty() || m.text.len() > s.model.context_bytes / 2 {
                    return Err("INVALID_SUMMARY".into());
                }
                s.summary = m.text;
                s.context_start = s.compact_end;
                schedule_model(&mut s)?;
            } else {
                // Never accept reused call ids: their results would be ambiguous.
                if m.calls.iter().any(|c| {
                    s.messages
                        .iter()
                        .flat_map(|m| &m.calls)
                        .any(|old| old.id == c.id)
                }) {
                    return Err("DUPLICATE_TOOL_CALL".into());
                }
                s.pending_calls = m.calls.clone();
                let done = s.pending_calls.is_empty();
                s.messages.push(m);
                if done {
                    s.status = "idle".into();
                } else {
                    schedule_tool(&mut s)?;
                }
            }
        }
        Command::Approve {
            effect_id, allow, ..
        } => {
            let (call, tool) = match checked_effect(&s, &effect_id)? {
                Effect::Approval { call, tool, .. } => (call.clone(), tool.clone()),
                _ => return Err("WRONG_EFFECT".into()),
            };
            if allow {
                s.status = "running".into();
                s.effect = Some(Effect::Tool {
                    id: uuid::Uuid::new_v4().to_string(),
                    call,
                    tool,
                });
            } else {
                finish_tool(&mut s, &call, "User declined this operation".into(), true)?;
            }
        }
        Command::Execute { effect_id, .. } => {
            if s.status == "executing" {
                return Err("EXECUTION_UNCERTAIN".into());
            }
            let (call, tool) = match checked_effect(&s, &effect_id)? {
                Effect::Tool { call, tool, .. } => (call.clone(), tool.clone()),
                _ => return Err("WRONG_EFFECT".into()),
            };
            if tool.source != "core" {
                return Err("EXTERNAL_TOOL".into());
            }
            // Persist the in-flight state before any side effect. A crash leaves
            // an interrupted call which can only be inspected, never replayed.
            s.status = "executing".into();
            store.save(&s)?;
            let result = tools::execute(&store.workspace(&s.id)?, &call);
            let (text, error) = match result {
                Ok(text) => (text, false),
                Err(e) => (e.to_string(), true),
            };
            finish_tool(&mut s, &call, text, error)?;
        }
        Command::ExtensionFile {
            effect_id,
            path,
            content,
            ..
        } => {
            if s.status != "executing" {
                return Err("TOOL_NOT_CLAIMED".into());
            }
            match checked_effect(&s, &effect_id)? {
                Effect::Tool { tool, .. } if tool.source != "core" => {}
                _ => return Err("WRONG_EFFECT".into()),
            }
            return Ok(json!(tools::execute(
                &store.workspace(&s.id)?,
                &ToolCall {
                    id: effect_id,
                    name: "write".into(),
                    arguments: json!({"path":path,"content":content})
                }
            )?));
        }
        Command::ClaimTool { effect_id, .. } => {
            if s.status == "executing" {
                return Err("EXECUTION_UNCERTAIN".into());
            }
            match checked_effect(&s, &effect_id)? {
                Effect::Tool { tool, .. } if tool.source != "core" => {}
                _ => return Err("WRONG_EFFECT".into()),
            }
            s.status = "executing".into();
        }
        Command::ToolResult {
            effect_id,
            result,
            is_error,
            ..
        } => {
            if s.status != "executing" {
                return Err("TOOL_NOT_CLAIMED".into());
            }
            let call = match checked_effect(&s, &effect_id)? {
                Effect::Tool { call, tool, .. } if tool.source != "core" => call.clone(),
                _ => return Err("WRONG_EFFECT".into()),
            };
            finish_tool(&mut s, &call, result, is_error)?;
        }
        Command::Fail {
            effect_id, code, ..
        } => {
            checked_effect(&s, &effect_id)?;
            interrupt(&mut s, "error");
            // Error codes only; raw HTTP bodies can include credentials.
            s.error = Some(
                if code.len() <= 80
                    && code
                        .chars()
                        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
                {
                    code
                } else {
                    "EXECUTION_FAILED".into()
                },
            );
        }
        Command::Cancel { .. } => interrupt(&mut s, "cancelled"),
        Command::Recover { .. } => {
            if s.effect.is_some() && s.status != "approval" {
                interrupt(&mut s, "interrupted");
            }
        }
        Command::Resume { tools, .. } => {
            if s.effect.is_some() {
                return Err("SESSION_BUSY".into());
            }
            s.tools = registry(tools)?;
            s.steps = 0;
            s.error = None;
            s.messages.push(Message::text(
                "user",
                "Continue the unfinished work. Check uncertain operation results before retrying."
                    .into(),
            ));
            schedule_model(&mut s)?;
        }
        _ => unreachable!(),
    }
    s.updated_at = now();
    store.save(&s)?;
    Ok(serde_json::to_value(s)?)
}

fn validate_model(model: &Model) -> Result<()> {
    if model.provider.is_empty()
        || model.model.is_empty()
        || !(4096..=4_000_000).contains(&model.context_bytes)
    {
        return Err("INVALID_MODEL".into());
    }
    Ok(())
}
fn registry(extra: Vec<Tool>) -> Result<Vec<Tool>> {
    let mut all = tools::descriptors();
    if extra.len() > 128 {
        return Err("TOO_MANY_TOOLS".into());
    }
    for tool in extra {
        if tool.source == "core"
            || tool.source.is_empty()
            || tool.revision.is_empty()
            || tool.name.is_empty()
            || tool.name.len() > 64
            || !tool
                .name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
            || all.iter().any(|t| t.name == tool.name)
            || tool.parameters["type"] != "object"
        {
            return Err("INVALID_TOOL_REGISTRY".into());
        }
        all.push(tool);
    }
    Ok(all)
}
fn checked_effect<'a>(s: &'a Session, id: &str) -> Result<&'a Effect> {
    s.effect
        .as_ref()
        .filter(|e| e.id() == id)
        .ok_or_else(|| "STALE_EFFECT".into())
}
fn schedule_model(s: &mut Session) -> Result<()> {
    if s.steps >= 64 {
        interrupt(s, "interrupted");
        s.error = Some("STEP_LIMIT".into());
        return Ok(());
    }
    // Byte budget is deliberately conservative and provider-independent. Count
    // instructions and schemas too; never send an oversized compaction request.
    let compact = serde_json::to_vec(&models::request(s, false))?.len() > s.model.context_bytes;
    if compact {
        let boundaries: Vec<usize> = s
            .messages
            .iter()
            .enumerate()
            .filter(|(i, m)| *i > s.context_start && m.role == "user")
            .map(|(i, _)| i)
            .collect();
        let mut chosen = None;
        for boundary in boundaries {
            s.compact_end = boundary;
            if serde_json::to_vec(&models::request(s, true))?.len() > s.model.context_bytes {
                break;
            }
            chosen = Some(boundary);
        }
        let Some(end) = chosen else {
            interrupt(s, "error");
            s.error = Some("CONTEXT_FULL".into());
            return Ok(());
        };
        s.compact_end = end;
    }
    s.steps += 1;
    s.status = "running".into();
    s.effect = Some(Effect::Model {
        id: uuid::Uuid::new_v4().to_string(),
        model: s.model.clone(),
        body: models::request(s, compact),
        compact,
    });
    Ok(())
}
fn schedule_tool(s: &mut Session) -> Result<()> {
    if s.pending_calls.is_empty() {
        return schedule_model(s);
    }
    let call = s.pending_calls[0].clone();
    let Some(tool) = s.tools.iter().find(|t| t.name == call.name).cloned() else {
        return finish_tool(s, &call, "Tool is not available".into(), true);
    };
    let id = uuid::Uuid::new_v4().to_string();
    // Extension operations always require approval; a third-party readOnly
    // annotation is not a trusted authorization decision.
    if tool.writes || tool.source != "core" {
        s.status = "approval".into();
        s.effect = Some(Effect::Approval { id, call, tool });
    } else {
        s.status = "running".into();
        s.effect = Some(Effect::Tool { id, call, tool });
    }
    Ok(())
}
fn finish_tool(s: &mut Session, call: &ToolCall, text: String, error: bool) -> Result<()> {
    if s.pending_calls.first().map(|c| &c.id) != Some(&call.id) {
        return Err("STALE_TOOL_CALL".into());
    }
    let truncated = text.chars().count() > 16_000;
    let mut text: String = text.chars().take(16_000).collect();
    if truncated {
        text.push_str("\n[Output truncated; inspect the source file for more.]");
    }
    s.messages.push(Message {
        client_id: None,
        created_at: now(),
        role: "tool".into(),
        text,
        calls: vec![],
        call_id: Some(call.id.clone()),
        is_error: error,
        provider_content: None,
    });
    s.pending_calls.remove(0);
    s.effect = None;
    schedule_tool(s)
}
fn interrupt(s: &mut Session, status: &str) {
    for call in s.pending_calls.drain(..) {
        s.messages.push(Message{client_id:None,created_at:now(),role:"tool".into(),text:"Execution interrupted. The operation may or may not have completed. Inspect current state before retrying.".into(),calls:vec![],call_id:Some(call.id),is_error:true,provider_content:None});
    }
    s.effect = None;
    s.status = status.into();
}
