// SPDX-License-Identifier: MPL-2.0
//! A small single-threaded WASM ABI around Brave's actual engine, not a matcher.
use adblock::{Engine, lists::{FilterSet, ParseOptions}, request::Request};
use std::cell::RefCell;
use serde_json::{Value, json};
thread_local! {
    static ENGINE: RefCell<Engine> = RefCell::new(Engine::default());
    static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[unsafe(no_mangle)]
pub extern "C" fn input_buffer(len: usize) -> *mut u8 {
    INPUT.with_borrow_mut(|buffer| { buffer.resize(len, 0); buffer.as_mut_ptr() })
}

fn dispatch(value: Value) -> Result<Value, String> {
    match value["op"].as_str() {
        Some("load") => {
            let lists = value["lists"].as_array().ok_or("lists must be an array")?;
            let mut filters = FilterSet::new(false);
            for list in lists {
                filters.add_filter_list(list.as_str().ok_or("list must be text")?.to_owned(), ParseOptions::default());
            }
            let engine = Engine::new_with_filter_set(filters);
            ENGINE.with_borrow_mut(|current| *current = engine);
            Ok(json!({"loaded": true}))
        }
        Some("check") => {
            let request = Request::new(value["url"].as_str().ok_or("url missing")?, value["source"].as_str().ok_or("source missing")?, value["type"].as_str().ok_or("type missing")?, value["method"].as_str().unwrap_or("GET")).map_err(|e| format!("{e:?}"))?;
            ENGINE.with_borrow(|engine| {
                let result = engine.check_network_request(&request);
                let mut value = serde_json::to_value(&result).map_err(|e| e.to_string())?;
                value["matched"] = json!(result.should_block());
                Ok(value)
            })
        }
        Some("cosmetic") => ENGINE.with_borrow(|engine| serde_json::to_value(engine.url_cosmetic_resources(value["url"].as_str().ok_or("url missing")?)).map_err(|e| e.to_string())),
        _ => Err("unknown operation".into()),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn execute() -> *const u8 {
    let result = INPUT.with_borrow(|buffer| serde_json::from_slice(buffer).map_err(|e| e.to_string()).and_then(dispatch));
    OUTPUT.with_borrow_mut(|buffer| {
        *buffer = serde_json::to_vec(&result.unwrap_or_else(|error| json!({"error": error}))).expect("JSON serialization");
        buffer.as_ptr()
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn output_len() -> usize { OUTPUT.with_borrow(|buffer| buffer.len()) }

/// Native callers pass a valid NUL-terminated UTF-8 string and consume the
/// returned string before the next call. All calls stay on the browser main thread.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn execute_json(input: *const std::ffi::c_char) -> *const std::ffi::c_char {
    if input.is_null() { return std::ptr::null(); }
    let text = unsafe { std::ffi::CStr::from_ptr(input) };
    let result = serde_json::from_slice(text.to_bytes()).map_err(|e| e.to_string()).and_then(dispatch);
    OUTPUT.with_borrow_mut(|buffer| {
        *buffer = serde_json::to_vec(&result.unwrap_or_else(|error| json!({"error": error}))).expect("JSON serialization");
        buffer.push(0);
        buffer.as_ptr().cast()
    })
}
