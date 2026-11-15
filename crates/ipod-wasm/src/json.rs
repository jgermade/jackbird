//! The little JSON the exports answer with, written by hand: the crate takes no serde.

use std::fmt::Write;

/// A JSON object or array being written.
pub struct Json {
    out: String,
    /// Whether the open object or array needs a comma before its next member.
    comma: Vec<bool>,
}

impl Default for Json {
    fn default() -> Self {
        Json {
            out: String::new(),
            comma: vec![false],
        }
    }
}

impl Json {
    fn separate(&mut self) {
        if let Some(last) = self.comma.last_mut() {
            if *last {
                self.out.push(',');
            }
            *last = true;
        }
    }

    fn key(&mut self, key: Option<&str>) {
        self.separate();
        if let Some(key) = key {
            string_into(&mut self.out, key);
            self.out.push(':');
        }
    }

    /// Opens an object, as the member `key` (or an item, with none).
    pub fn open(&mut self, key: Option<&str>) -> &mut Self {
        self.key(key);
        self.out.push('{');
        self.comma.push(false);
        self
    }

    /// Opens an array, as the member `key` (or an item, with none).
    pub fn open_list(&mut self, key: Option<&str>) -> &mut Self {
        self.key(key);
        self.out.push('[');
        self.comma.push(false);
        self
    }

    /// Closes the open object.
    pub fn close(&mut self) -> &mut Self {
        self.comma.pop();
        self.out.push('}');
        self
    }

    /// Closes the open array.
    pub fn close_list(&mut self) -> &mut Self {
        self.comma.pop();
        self.out.push(']');
        self
    }

    /// A string member.
    pub fn text(&mut self, key: &str, value: &str) -> &mut Self {
        self.key(Some(key));
        string_into(&mut self.out, value);
        self
    }

    /// A number member.
    pub fn number(&mut self, key: &str, value: impl Into<f64>) -> &mut Self {
        self.key(Some(key));
        let value: f64 = value.into();
        let _ = write!(self.out, "{value}");
        self
    }

    /// A true or false member.
    pub fn flag(&mut self, key: &str, value: bool) -> &mut Self {
        self.key(Some(key));
        self.out.push_str(if value { "true" } else { "false" });
        self
    }

    /// A null member.
    pub fn null(&mut self, key: &str) -> &mut Self {
        self.key(Some(key));
        self.out.push_str("null");
        self
    }

    /// What was written.
    pub fn finish(self) -> String {
        self.out
    }
}

/// `text` as a JSON string, into `out`.
fn string_into(out: &mut String, text: &str) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_objects_lists_and_escapes() {
        let mut json = Json::default();
        json.open(None)
            .text("name", "a \"b\"\\\n\u{1}é")
            .number("n", 3u32)
            .number("f", 1.5);
        json.open_list(Some("list"));
        json.open(None).flag("yes", true).null("none").close();
        json.open(None).flag("no", false).close();
        json.close_list().open(Some("empty")).close().close();
        assert_eq!(
            json.finish(),
            r#"{"name":"a \"b\"\\\n\u0001é","n":3,"f":1.5,"list":[{"yes":true,"none":null},{"no":false}],"empty":{}}"#
        );
    }
}
