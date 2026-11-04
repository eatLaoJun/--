import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareTemplateWorkspace } from "../src/integrations/git.js";

const projectRoot = process.cwd();

test("patch fingerprint is stable across commit and changedFiles keeps full paths", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fp-git-"));
  try {
    const prepared = await prepareTemplateWorkspace(
      path.join(projectRoot, "fixtures/demo-repo"),
      path.join(dir, "workspace"),
      "T-GIT",
    );
    const file = path.join(prepared.workspace.path, "src/pagination.js");
    const original = await import("node:fs/promises").then((fs) => fs.readFile(file, "utf8"));
    await writeFile(file, original.replace("Math.floor(total / pageSize) + 1", "Math.ceil(total / pageSize)"), "utf8");

    const before = await prepared.workspace.diff();
    const beforeHash = await prepared.workspace.patchHash();
    const beforeFiles = await prepared.workspace.changedFiles();
    assert.deepEqual(beforeFiles, ["src/pagination.js"]);
    assert.match(before, /src\/pagination\.js/);

    await prepared.workspace.commitAll("fix pagination");
    assert.equal(await prepared.workspace.patchHash(), beforeHash, "commit must not change the patch fingerprint");
    assert.deepEqual(await prepared.workspace.changedFiles(), ["src/pagination.js"]);
    assert.match(await prepared.workspace.diff(), /Math\.ceil/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
