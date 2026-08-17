/**
 * Running LibreOffice, once, safely.
 *
 * This is the whole reason a server exists at all: a browser cannot open a
 * .docx, and LibreOffice can. Everything else on utilade.com runs on the
 * visitor's own machine.
 *
 * Three things here are not optional, and each is a trap that only shows up
 * under real traffic:
 *
 *   1. **Every job gets its own LibreOffice profile.** Two headless instances
 *      sharing one profile directory do not queue politely — the second sees a
 *      lock, decides an instance is already running, and either hangs or exits
 *      having written nothing. With `MAX_CONCURRENT` above 1 that is not an
 *      edge case, it is Tuesday.
 *   2. **The process is killed on a timer, not trusted.** A malformed file can
 *      put LibreOffice into a dialog it is waiting on for ever, in a headless
 *      process where no one can click OK.
 *   3. **The job's directory is deleted whatever happens.** We tell every
 *      visitor their file is not kept. That promise is either true in this
 *      function or it is not true anywhere.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname, basename } from "node:path";

/** What LibreOffice is allowed to be asked for, and what comes back. */
const TARGETS = new Map([
  ["pdf", { filter: "pdf", extension: "pdf", type: "application/pdf" }],
  [
    "docx",
    {
      filter: "docx:MS Word 2007 XML",
      extension: "docx",
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
  ],
  [
    "xlsx",
    {
      filter: "xlsx:Calc MS Excel 2007 XML",
      extension: "xlsx",
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
  ],
  [
    "pptx",
    {
      filter: "pptx:Impress MS PowerPoint 2007 XML",
      extension: "pptx",
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    },
  ],
]);

/** Extensions we accept in. Anything else is refused before a process starts. */
const SOURCES = new Set([
  ".doc", ".docx", ".odt", ".rtf", ".txt",
  ".xls", ".xlsx", ".ods", ".csv",
  ".ppt", ".pptx", ".odp",
  ".html", ".htm",
  /* PDF in is a different engine entirely — see convertPdfToWord below. */
  ".pdf",
]);

/**
 * What a PDF may become.
 *
 * Only Word, and only through pdf2docx. LibreOffice will happily accept a PDF
 * and produce a .xlsx or a .pptx from it, and the result is meaningless — a
 * spreadsheet of one enormous cell, a deck of floating boxes. Refusing is the
 * honest answer.
 */
const PDF_TARGETS = new Set(["docx"]);

export function isSupported(fileName, target) {
  const extension = extname(fileName).toLowerCase();
  if (!SOURCES.has(extension) || !TARGETS.has(target)) return false;
  if (extension === ".pdf") return PDF_TARGETS.has(target);
  /* Everything else converts to PDF only; asking for .docx from a .xlsx is a
     request nobody meant to make. */
  return target === "pdf";
}

export function supported() {
  return { from: [...SOURCES], to: [...TARGETS.keys()] };
}

/**
 * Convert one file and return the bytes.
 *
 * Throws with a message a person could act on — the caller shows it to whoever
 * uploaded the file, so "exit code 137" is not an answer.
 */
export async function convert(bytes, fileName, target, { timeoutMs = 60_000, engine } = {}) {
  const wanted = TARGETS.get(target);
  if (!wanted) throw new Error(`Cannot convert to ${target}.`);

  const extension = extname(fileName).toLowerCase();
  if (!SOURCES.has(extension)) {
    throw new Error(`Cannot convert a ${extension || "file with no extension"}.`);
  }

  /* One directory per job, holding the input, the output and LibreOffice's own
     profile. Deleting it deletes all three. */
  const workDir = await mkdtemp(join(tmpdir(), "utilade-"));

  try {
    if (extension === ".pdf") {
      return await convertPdfToWord(bytes, workDir, timeoutMs, engine);
    }

    /* The name is taken from the caller, so it is rebuilt from nothing but an
       extension — a filename is an excellent way to write somewhere else. */
    const inputPath = join(workDir, `input${extension}`);
    await writeFile(inputPath, bytes);

    await runSoffice(
      [
        "--headless",
        "--norestore",
        `-env:UserInstallation=file://${join(workDir, "profile")}`,
        "--convert-to",
        wanted.filter,
        "--outdir",
        workDir,
        inputPath,
      ],
      timeoutMs,
      workDir,
    );

    /* LibreOffice names the output after the input, but not always with the
       extension you asked for — a filter can disagree. Find it rather than
       assume it. */
    const produced = (await readdir(workDir)).find(
      (name) => name.startsWith("input.") && name !== basename(inputPath),
    );

    if (!produced) {
      throw new Error(
        "The document could not be converted. It may be password-protected, or damaged.",
      );
    }

    return {
      bytes: await readFile(join(workDir, produced)),
      type: wanted.type,
      extension: extname(produced).slice(1) || wanted.extension,
    };
  } finally {
    /* Deliberately not awaited for its result: a failure to clean up must not
       replace the real error, but it must still be attempted. */
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * PDF → Word, through pdf2docx rather than LibreOffice.
 *
 * LibreOffice imports a PDF into a drawing program, so every line of text
 * becomes a floating frame and the result is a file nobody can edit. pdf2docx
 * reconstructs paragraphs and tables instead.
 */
async function convertPdfToWord(bytes, workDir, timeoutMs, engine = "layout") {
  const inputPath = join(workDir, "input.pdf");
  const outputPath = join(workDir, "output.docx");
  await writeFile(inputPath, bytes);

  if (engine === "editable") {
    /* Measured and withdrawn, not forgotten.
       Docling produced better, genuinely editable output and took over 120
       seconds for five pages on this box — and Cloudflare abandons an origin
       after 100 seconds regardless, so it could never have answered a real
       document. Kept as an explicit refusal rather than silently doing
       something else, because a caller asking for it deserves to know why. */
    throw new Error(
      "The editable engine is not available on this server yet — it is too slow for the hardware. Converting with the layout engine instead is the current answer.",
    );
  }

  {

    await run(
      process.env.PDF2DOCX ?? "pdf2docx",
      ["convert", inputPath, outputPath],
      timeoutMs,
      workDir,
    );
  }

  return {
    bytes: await readFile(outputPath),
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extension: "docx",
  };
}

function runSoffice(args, timeoutMs, home) {
  return run("soffice", args, timeoutMs, home);
}

function run(command, args, timeoutMs, home) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      /* LibreOffice writes into HOME regardless of what else it is told, so
         each job gets the job's own directory as its home. Two jobs sharing
         one home is the lock collision described at the top of this file. */
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });

    /* Keep the **end** of the output, not the beginning.
       A failing process says why on its last line, and everything before it is
       progress bars and warnings. Capping the front meant every error report
       was four kilobytes of "loading weights" and no reason — which cost two
       rebuild cycles to notice. Bounded still, because a process in a loop can
       produce megabytes. */
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-4000);
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          "The document took too long to convert. Very large or complex files can exceed the limit.",
        ),
      );
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not start the converter: ${error.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `The converter exited with code ${code}.`));
    });
  });
}
