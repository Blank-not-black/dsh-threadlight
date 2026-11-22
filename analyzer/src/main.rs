use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, error::Error, fs::File, io};
use tree_sitter::{Node, Parser};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    schema_version: u32,
    files: Vec<InputFile>,
}

#[derive(Deserialize)]
struct InputFile {
    path: String,
    text: String,
    lines: Vec<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    schema_version: u32,
    files: Vec<IndexedFile>,
}

#[derive(Serialize)]
struct IndexedFile {
    path: String,
    matches: Vec<Symbol>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Symbol {
    line: usize,
    name: String,
    kind: &'static str,
    start_line: usize,
    end_line: usize,
}

fn named_construct(node: Node<'_>) -> Option<(&'static str, Node<'_>)> {
    let kind = match node.kind() {
        "function_declaration"
        | "generator_function_declaration"
        | "function_expression"
        | "generator_function" => "function",
        "class_declaration" => "class",
        "method_definition" => "method",
        "import_statement" => return Some(("import", node.child_by_field_name("source")?)),
        "variable_declarator" => match node.child_by_field_name("value")?.kind() {
            "arrow_function" | "function_expression" | "generator_function" => "function",
            "class" => "class",
            _ => return None,
        },
        "call_expression" => {
            let target = node.child_by_field_name("function")?;
            return matches!(target.kind(), "identifier" | "member_expression")
                .then_some(("call", target));
        }
        _ => return None,
    };
    let name = node.child_by_field_name("name")?;
    matches!(
        name.kind(),
        "identifier" | "property_identifier" | "private_property_identifier"
    )
    .then_some((kind, name))
}

fn index_file(parser: &mut Parser, file: InputFile) -> io::Result<IndexedFile> {
    let tree = parser
        .parse(&file.text, None)
        .ok_or_else(|| io::Error::other("JavaScript parsing stopped"))?;
    let mut wanted: BTreeMap<_, _> = file.lines.into_iter().map(|line| (line, None)).collect();
    let mut stack = vec![tree.root_node()];
    while let Some(node) = stack.pop() {
        let start = node.start_position().row + 1;
        let end_point = node.end_position();
        let end = (end_point.row + usize::from(end_point.column > 0)).max(start);
        if wanted.range(start..=end).next().is_none() {
            continue;
        }
        if let Some((kind, name)) = named_construct(node) {
            let name = name.utf8_text(file.text.as_bytes()).unwrap_or("");
            if !name.is_empty()
                && !name.contains(['\r', '\n'])
                && name.encode_utf16().count() <= 160
            {
                let rank = (kind == "call", node.byte_range().len());
                for (&line, matched) in wanted.range_mut(start..=end) {
                    if matched
                        .as_ref()
                        .is_none_or(|(existing, _)| rank < *existing)
                    {
                        *matched = Some((
                            rank,
                            Symbol {
                                line,
                                name: name.into(),
                                kind,
                                start_line: start,
                                end_line: end,
                            },
                        ));
                    }
                }
            }
        }
        let mut cursor = node.walk();
        stack.extend(node.named_children(&mut cursor));
    }
    Ok(IndexedFile {
        path: file.path,
        matches: wanted
            .into_values()
            .flatten()
            .map(|(_, symbol)| symbol)
            .collect(),
    })
}

fn main() -> Result<(), Box<dyn Error>> {
    let path = std::env::args_os()
        .nth(1)
        .ok_or("Expected a JSON input file")?;
    let request: Request = serde_json::from_reader(io::BufReader::new(File::open(path)?))?;
    if request.schema_version != 1 {
        return Err("Unsupported request schema".into());
    }
    let mut parser = Parser::new();
    parser.set_language(&tree_sitter_javascript::LANGUAGE.into())?;
    let files = request
        .files
        .into_iter()
        .map(|file| index_file(&mut parser, file))
        .collect::<io::Result<Vec<_>>>()?;
    serde_json::to_writer(
        io::stdout().lock(),
        &Report {
            schema_version: 1,
            files,
        },
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locates_the_innermost_named_symbol_and_syntactic_references() {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_javascript::LANGUAGE.into())
            .unwrap();
        let result = index_file(
            &mut parser,
            InputFile {
                path: "project.mjs".into(),
                text:
                    "function outer() {\n  const inner = () => {\n    save();\n  };\n}\nouter();\nimport './setup.js';\n"
                        .into(),
                lines: vec![1, 3, 6, 7, 8],
            },
        )
        .unwrap();
        let symbols: Vec<_> = result
            .matches
            .iter()
            .map(|hit| (hit.line, hit.name.as_str(), hit.kind))
            .collect();
        assert_eq!(
            symbols,
            [
                (1, "outer", "function"),
                (3, "inner", "function"),
                (6, "outer", "call"),
                (7, "'./setup.js'", "import")
            ]
        );
    }
}
