use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Model {
    pub provider: String,
    pub model: String,
    pub protocol: Protocol,
    #[serde(default = "default_context")]
    pub context_bytes: usize,
}
fn default_context() -> usize {
    48_000
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Protocol {
    Openai,
    Responses,
    Anthropic,
    Google,
    Apple,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Tool {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    /// Host-provided identity, never supplied by the model.
    pub source: String,
    pub revision: String,
    pub writes: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Message {
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default = "now")]
    pub created_at: u64,
    pub role: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub calls: Vec<ToolCall>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    #[serde(default)]
    pub is_error: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_content: Option<Value>,
}
impl Message {
    pub fn text(role: &str, text: String) -> Self {
        Self {
            client_id: None,
            created_at: now(),
            role: role.into(),
            text,
            calls: vec![],
            call_id: None,
            is_error: false,
            provider_content: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Effect {
    Model {
        id: String,
        model: Model,
        body: Value,
        compact: bool,
    },
    Approval {
        id: String,
        call: ToolCall,
        tool: Tool,
    },
    Tool {
        id: String,
        call: ToolCall,
        tool: Tool,
    },
}
impl Effect {
    pub fn id(&self) -> &str {
        match self {
            Self::Model { id, .. } | Self::Approval { id, .. } | Self::Tool { id, .. } => id,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Session {
    #[serde(default = "now")]
    pub created_at: u64,
    #[serde(default = "now")]
    pub updated_at: u64,
    #[serde(default)]
    pub metadata: serde_json::Map<String, Value>,
    pub version: u32,
    pub id: String,
    pub title: String,
    pub model: Model,
    pub messages: Vec<Message>,
    pub status: String,
    pub effect: Option<Effect>,
    pub tools: Vec<Tool>,
    pub pending_calls: Vec<ToolCall>,
    pub summary: String,
    pub context_start: usize,
    pub compact_end: usize,
    pub steps: u32,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Command {
    Create {
        #[serde(default)]
        id: Option<String>,
        title: String,
        model: Model,
    },
    List,
    Update {
        id: String,
        title: Option<String>,
        #[serde(default)]
        metadata: serde_json::Map<String, Value>,
        model: Option<Model>,
    },
    Load {
        id: String,
    },
    Submit {
        id: String,
        #[serde(default)]
        client_id: Option<String>,
        text: String,
        model: Model,
        #[serde(default)]
        tools: Vec<Tool>,
    },
    ModelResult {
        id: String,
        effect_id: String,
        response: Value,
    },
    Approve {
        id: String,
        effect_id: String,
        allow: bool,
    },
    ExtensionFile {
        id: String,
        effect_id: String,
        path: String,
        content: String,
    },
    ClaimTool {
        id: String,
        effect_id: String,
    },
    Execute {
        id: String,
        effect_id: String,
    },
    ToolResult {
        id: String,
        effect_id: String,
        result: String,
        #[serde(default)]
        is_error: bool,
    },
    Fail {
        id: String,
        effect_id: String,
        code: String,
    },
    Cancel {
        id: String,
    },
    Recover {
        id: String,
    },
    Resume {
        id: String,
        #[serde(default)]
        tools: Vec<Tool>,
    },
    Files {
        id: String,
        #[serde(default)]
        path: String,
    },
    ReadFile {
        id: String,
        path: String,
    },
}

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
