export function readCsvRows(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let mode: "bare" | "quoted" | "closed" = "bare";
  const csv = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

  function finishField() {
    row.push(value);
    value = "";
    mode = "bare";
  }

  function finishRow() {
    finishField();
    if (row.length > 1 || row[0].trim()) rows.push(row);
    row = [];
  }

  for (let position = 0; position < csv.length; position += 1) {
    const character = csv[position];
    if (mode === "quoted") {
      if (character !== '"') value += character;
      else if (csv[position + 1] === '"') {
        value += '"';
        position += 1;
      } else mode = "closed";
      continue;
    }

    if (character === ",") finishField();
    else if (character === "\n") finishRow();
    else if (mode === "closed" || (character === '"' && value)) {
      throw new Error("A quoted CSV field is malformed. Check the file against the template.");
    } else if (character === '"') mode = "quoted";
    else value += character;
  }

  if (mode === "quoted") throw new Error("A quoted CSV field is missing its closing quote.");
  finishRow();
  return rows;
}

export function validCsvCell(value: string, maxLength: number) {
  return value.length <= maxLength && !Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159);
  });
}
