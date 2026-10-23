use serde_json::json;
use std::{
    ffi::{CStr, CString, c_char},
    path::Path,
};

fn dispatch(root: &str, input: &str) -> String {
    let outcome = std::panic::catch_unwind(|| {
        if input.len() > 16 * 1024 * 1024 {
            return Err("REQUEST_TOO_LARGE".into());
        }
        let command = serde_json::from_str(input)?;
        crate::invoke(Path::new(root), command)
    });
    match outcome {
        Ok(Ok(value)) => json!({"ok":true,"value":value}).to_string(),
        Ok(Err(error)) => {
            let text = error.to_string();
            let code = if text.len() <= 80
                && text
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
            {
                text
            } else {
                "STORAGE_OR_PROTOCOL_ERROR".into()
            };
            json!({"ok":false,"error":code}).to_string()
        }
        Err(_) => json!({"ok":false,"error":"KERNEL_PANIC"}).to_string(),
    }
}

/// # Safety
/// Both pointers must be valid NUL-terminated UTF-8 owned by the trusted host.
/// Free the returned pointer exactly once with cindy_harness_free.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cindy_harness_call(
    root: *const c_char,
    input: *const c_char,
) -> *mut c_char {
    if root.is_null() || input.is_null() {
        return std::ptr::null_mut();
    }
    let root = unsafe { CStr::from_ptr(root) }.to_str();
    let input = unsafe { CStr::from_ptr(input) }.to_str();
    let output = match (root, input) {
        (Ok(root), Ok(input)) => dispatch(root, input),
        _ => json!({"ok":false,"error":"INVALID_UTF8"}).to_string(),
    };
    CString::new(output).expect("JSON escapes NUL").into_raw()
}
/// # Safety
/// Pointer must be returned by cindy_harness_call and not already freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cindy_harness_free(value: *mut c_char) {
    if !value.is_null() {
        drop(unsafe { CString::from_raw(value) });
    }
}

#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
pub extern "system" fn Java_app_cindy_harness_CindyMobileHarnessModule_nativeCall(
    mut env: jni::JNIEnv,
    _object: jni::objects::JObject,
    root: jni::objects::JString,
    input: jni::objects::JString,
) -> jni::sys::jstring {
    let result = (|| -> std::result::Result<_, jni::errors::Error> {
        let root: String = env.get_string(&root)?.into();
        let input: String = env.get_string(&input)?.into();
        env.new_string(dispatch(&root, &input))
    })();
    match result {
        Ok(s) => s.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}
