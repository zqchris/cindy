use crate::{
    Result,
    types::{Tool, ToolCall},
};
use cap_std::fs::Dir;
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    path::{Component, Path},
};

const MAX_FILE: u64 = 2 * 1024 * 1024;

pub fn descriptors() -> Vec<Tool> {
    [
        ("read", "Read a UTF-8 file in the task workspace.", json!({"path":{"type":"string"}}), vec!["path"], false),
        ("write", "Atomically write a UTF-8 file, creating its parent directories.", json!({"path":{"type":"string"},"content":{"type":"string"}}), vec!["path","content"], true),
        ("edit", "Replace one unique exact occurrence in a UTF-8 file.", json!({"path":{"type":"string"},"old":{"type":"string"},"new":{"type":"string"}}), vec!["path","old","new"], true),
        ("list", "List files and directories under a relative workspace path.", json!({"path":{"type":"string"}}), vec![], false),
        ("search", "Search UTF-8 files for literal text. Returns paths, line numbers and matching lines.", json!({"query":{"type":"string"}}), vec!["query"], false),
    ].into_iter().map(|(name,description,properties,required,writes)|Tool { name:name.into(),description:description.into(),parameters:json!({"type":"object","properties":properties,"required":required,"additionalProperties":false}),source:"core".into(),revision:"1".into(),writes }).collect()
}

pub fn execute(dir: &Dir, call: &ToolCall) -> Result<String> {
    let args = &call.arguments;
    match call.name.as_str() {
        "read" => read(dir, arg(args, "path")?),
        "list" => {
            let path = args["path"].as_str().unwrap_or(".");
            validate(path)?;
            let sub = dir.open_dir(path)?;
            let mut entries = vec![];
            for entry in sub.entries()?.take(1001) {
                let entry = entry?;
                entries.push(json!({"name":entry.file_name().to_string_lossy(),"directory":entry.file_type()?.is_dir()}));
            }
            if entries.len() > 1000 {
                return Err("TOO_MANY_FILES".into());
            }
            Ok(serde_json::to_string(&entries)?)
        }
        "write" => {
            write(dir, arg(args, "path")?, arg(args, "content")?)?;
            Ok("Saved".into())
        }
        "edit" => {
            let path = arg(args, "path")?;
            let old = arg(args, "old")?;
            let text = read(dir, path)?;
            if old.is_empty() || text.matches(old).count() != 1 {
                return Err("EDIT_MATCH_NOT_UNIQUE".into());
            }
            write(dir, path, &text.replacen(old, arg(args, "new")?, 1))?;
            Ok("Saved".into())
        }
        "search" => {
            let query = arg(args, "query")?;
            if query.is_empty() {
                return Err("EMPTY_QUERY".into());
            }
            let mut found = vec![];
            let mut stack = vec![String::from(".")];
            let mut visited = 0;
            while let Some(path) = stack.pop() {
                for entry in dir.read_dir(&path)? {
                    visited += 1;
                    if visited > 1000 {
                        return Err("TOO_MANY_FILES".into());
                    }
                    let e = entry?;
                    let p = Path::new(&path)
                        .join(e.file_name())
                        .to_string_lossy()
                        .into_owned();
                    let kind = e.file_type()?;
                    if kind.is_dir() {
                        stack.push(p);
                    } else if kind.is_file()
                        && let Ok(text) = read(dir, &p)
                    {
                        for (line, text) in text.lines().enumerate() {
                            if text.contains(query) {
                                found.push(json!({"path":p,"line":line+1,"text":text.chars().take(500).collect::<String>()}));
                            }
                            if found.len() >= 100 {
                                return Ok(serde_json::to_string(&found)?);
                            }
                        }
                    }
                }
            }
            Ok(serde_json::to_string(&found)?)
        }
        _ => Err("UNKNOWN_CORE_TOOL".into()),
    }
}
fn arg<'a>(v: &'a Value, name: &str) -> Result<&'a str> {
    v[name]
        .as_str()
        .ok_or_else(|| "INVALID_TOOL_ARGUMENTS".into())
}
fn validate(path: &str) -> Result<()> {
    if path.is_empty()
        || Path::new(path).components().any(|c| {
            matches!(
                c,
                Component::RootDir | Component::Prefix(_) | Component::ParentDir
            )
        })
    {
        return Err("PATH_OUTSIDE_WORKSPACE".into());
    }
    Ok(())
}
fn read(dir: &Dir, path: &str) -> Result<String> {
    validate(path)?;
    let file = dir.open(path)?;
    if !file.metadata()?.is_file() {
        return Err("NOT_A_FILE".into());
    }
    let mut out = String::new();
    file.take(MAX_FILE + 1).read_to_string(&mut out)?;
    if out.len() as u64 > MAX_FILE {
        return Err("FILE_TOO_LARGE".into());
    }
    Ok(out)
}
fn write(dir: &Dir, path: &str, text: &str) -> Result<()> {
    validate(path)?;
    if text.len() as u64 > MAX_FILE {
        return Err("FILE_TOO_LARGE".into());
    }
    let path = Path::new(path);
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    dir.create_dir_all(parent)?;
    let parent = dir.open_dir(parent)?;
    let name = path.file_name().ok_or("INVALID_PATH")?;
    let temp = format!(".cindy-{}", uuid::Uuid::new_v4());
    let result = (|| -> Result<()> {
        let mut file = parent.open_with(
            &temp,
            cap_std::fs::OpenOptions::new().write(true).create_new(true),
        )?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        parent.rename(&temp, &parent, name)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = parent.remove_file(&temp);
    }
    result
}
