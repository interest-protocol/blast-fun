import assert from "node:assert/strict";
import test from "node:test";

import { createWorkspaceSession, WORKSPACE_SESSION_KEY } from "./session";

test("entry resumes only an open browser session and preserves the local origin and scroll", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const session = createWorkspaceSession(storage, "https://blast.test");
  assert.equal(session.getSnapshot().open, false);
  session.open({
    path: "/presale?status=live#next",
    scroll_x: 0,
    scroll_y: 451,
    main_scroll_top: 143,
  });
  assert.equal(session.getSnapshot().generation, 1);
  const resumed = createWorkspaceSession(storage, "https://blast.test");
  assert.equal(resumed.getSnapshot().open, true);
  assert.deepEqual(resumed.getSnapshot().origin, {
    path: "/presale?status=live#next",
    scroll_x: 0,
    scroll_y: 451,
    main_scroll_top: 143,
  });
  resumed.close();
  assert.equal(
    createWorkspaceSession(storage, "https://blast.test").getSnapshot().open,
    false,
  );
  assert.ok(values.has(WORKSPACE_SESSION_KEY));
});

test("a phone cannot restore a saved session or open a new one", () => {
  const origin = { path: "/presale", scroll_x: 0, scroll_y: 0, main_scroll_top: 0 };
  const session = createWorkspaceSession(
    {
      getItem: () => JSON.stringify({ open: true, origin }),
      setItem() {},
    },
    "https://blast.test",
    () => false,
  );
  assert.equal(session.getSnapshot().open, false);
  session.open(origin);
  assert.equal(session.getSnapshot().open, false);
});

test("unsafe origins never resume and blocked storage stays a truthful memory-only session", () => {
  for (const path of [
    "https://evil.test/path",
    "//evil.test",
    "/\\evil.test",
    "/path\nheader",
  ]) {
    const storage = {
      getItem: () =>
        JSON.stringify({
          open: true,
          origin: { path, scroll_x: 0, scroll_y: 0, main_scroll_top: 0 },
        }),
      setItem() {},
    };
    assert.equal(
      createWorkspaceSession(storage, "https://blast.test").getSnapshot().open,
      false,
    );
  }
  const blocked = createWorkspaceSession(
    {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    },
    "https://blast.test",
  );
  blocked.open({
    path: "/presale",
    scroll_x: 0,
    scroll_y: 0,
    main_scroll_top: 0,
  });
  assert.equal(blocked.getSnapshot().open, true);
  assert.equal(blocked.getSnapshot().durable, false);
  assert.equal(
    createWorkspaceSession(
      { getItem: () => null, setItem() {} },
      "https://blast.test",
    ).getSnapshot().open,
    false,
  );
});
