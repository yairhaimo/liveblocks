import {
  createSerializedList,
  createSerializedMap,
  createSerializedObject,
  prepareStorageTest,
} from "../../__tests__/_utils";
import { OpCode } from "../../protocol/Op";
import type { LiveList } from "../LiveList";
import type { LiveMap } from "../LiveMap";
import type { LiveObject } from "../LiveObject";

describe("Storage", () => {
  describe("subscribe generic", () => {
    test("simple action", async () => {
      const { storage, subscribe } = await prepareStorageTest<{ a: number }>(
        [createSerializedObject("0:0", { a: 0 })],
        1
      );

      const callback = jest.fn();

      const unsubscribe = subscribe(callback);

      storage.root.set("a", 1);

      unsubscribe();

      storage.root.set("a", 2);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith([
        {
          type: "LiveObject",
          node: storage.root,
          updates: { a: { type: "update" } },
        },
      ]);
    });

    test("remote action", async () => {
      const { storage, applyRemoteOperations, subscribe } =
        await prepareStorageTest<{ a: number }>(
          [createSerializedObject("0:0", { a: 0 })],
          1
        );

      const callback = jest.fn();

      const unsubscribe = subscribe(callback);

      applyRemoteOperations([
        { type: OpCode.UPDATE_OBJECT, data: { a: 1 }, opId: "", id: "0:0" },
      ]);

      unsubscribe();

      applyRemoteOperations([
        { type: OpCode.UPDATE_OBJECT, data: { a: 2 }, opId: "", id: "0:0" },
      ]);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith([
        {
          type: "LiveObject",
          node: storage.root,
          updates: { a: { type: "update" } },
        },
      ]);
    });

    test("remote action with multipe updates on same object", async () => {
      const { storage, applyRemoteOperations, subscribe } =
        await prepareStorageTest<{ a: number }>(
          [createSerializedObject("0:0", { a: 0 })],
          1
        );

      const callback = jest.fn();

      const unsubscribe = subscribe(callback);

      applyRemoteOperations([
        { type: OpCode.UPDATE_OBJECT, data: { a: 1 }, opId: "", id: "0:0" },
        { type: OpCode.UPDATE_OBJECT, data: { b: 1 }, opId: "", id: "0:0" },
      ]);

      unsubscribe();

      applyRemoteOperations([
        { type: OpCode.UPDATE_OBJECT, data: { a: 2 }, opId: "", id: "0:0" },
      ]);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith([
        {
          type: "LiveObject",
          node: storage.root,
          updates: { a: { type: "update" }, b: { type: "update" } },
        },
      ]);
    });

    test("batch actions on a single LiveObject", async () => {
      const { storage, assertUndoRedo, subscribe, batch } =
        await prepareStorageTest<{ a: number; b: number }>(
          [createSerializedObject("0:0", { a: 0, b: 0 })],
          1
        );

      const callback = jest.fn();

      const root = storage.root;

      const unsubscribe = subscribe(callback);

      batch(() => {
        root.set("a", 1);
        root.set("b", 1);
      });

      unsubscribe();

      batch(() => {
        root.set("a", 2);
        root.set("b", 2);
      });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith([
        {
          type: "LiveObject",
          node: storage.root,
          updates: { a: { type: "update" }, b: { type: "update" } },
        },
      ]);

      assertUndoRedo();
    });

    test("batch actions on multiple LiveObjects", async () => {
      const { storage, subscribe, batch } = await prepareStorageTest<{
        a: number;
        child: LiveObject<{ b: number }>;
      }>(
        [
          createSerializedObject("0:0", { a: 0 }),
          createSerializedObject("0:1", { b: 0 }, "0:0", "child"),
        ],
        1
      );

      const callback = jest.fn();

      const root = storage.root;

      subscribe(callback);

      batch(() => {
        root.set("a", 1);
        root.get("child").set("b", 1);
      });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith([
        {
          type: "LiveObject",
          node: storage.root,
          updates: { a: { type: "update" } },
        },
        {
          type: "LiveObject",
          node: root.get("child"),
          updates: { b: { type: "update" } },
        },
      ]);
    });

    test("batch actions on multiple Live types", async () => {
      const { storage, subscribe, batch } = await prepareStorageTest<{
        a: number;
        childObj: LiveObject<{ b: number }>;
        childList: LiveList<string>;
        childMap: LiveMap<string, string>;
      }>(
        [
          createSerializedObject("0:0", { a: 0 }),
          createSerializedObject("0:1", { b: 0 }, "0:0", "childObj"),
          createSerializedList("0:2", "0:0", "childList"),
          createSerializedMap("0:3", "0:0", "childMap"),
        ],
        1
      );

      const callback = jest.fn();

      const root = storage.root;

      subscribe(callback);

      batch(() => {
        root.set("a", 1);
        root.get("childObj").set("b", 1);
        root.get("childList").push("item1");
        root.get("childMap").set("el1", "v1");
      });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith([
        {
          type: "LiveObject",
          node: storage.root,
          updates: { a: { type: "update" } },
        },
        {
          type: "LiveObject",
          node: root.get("childObj"),
          updates: { b: { type: "update" } },
        },
        {
          type: "LiveList",
          node: root.get("childList"),
          updates: [{ index: 0, item: "item1", type: "insert" }],
        },
        {
          type: "LiveMap",
          node: root.get("childMap"),
          updates: { el1: { type: "update" } },
        },
      ]);
    });
  });

  describe("batching", () => {
    it("batching and undo", async () => {
      const { storage, expectStorage, undo, redo, batch } =
        await prepareStorageTest<{
          items: LiveList<string>;
        }>(
          [
            createSerializedObject("0:0", {}),
            createSerializedList("0:1", "0:0", "items"),
          ],
          1
        );

      const items = storage.root.get("items");

      batch(() => {
        items.push("A");
        items.push("B");
        items.push("C");
      });

      expectStorage({
        items: ["A", "B", "C"],
      });

      undo();

      expectStorage({
        items: [],
      });

      redo();

      expectStorage({
        items: ["A", "B", "C"],
      });
    });

    it("nesting batches makes inner batches a no-op", async () => {
      const { storage, expectStorage, undo, redo, batch } =
        await prepareStorageTest<{
          items: LiveList<string>;
        }>(
          [
            createSerializedObject("0:0", {}),
            createSerializedList("0:1", "0:0", "items"),
          ],
          1
        );

      const items = storage.root.get("items");

      batch(() => {
        batch(() => {
          batch(() => {
            items.push("A");
            batch(() => {
              batch(() => {
                items.push("B");
                batch(() => {
                  batch(() => {
                    batch(() => {
                      items.push("C");
                    });
                  });
                });
              });
            });
          });
        });
      });

      expectStorage({
        items: ["A", "B", "C"],
      });

      undo();

      expectStorage({
        items: [],
      });

      redo();

      expectStorage({
        items: ["A", "B", "C"],
      });
    });

    it("batch callbacks can return a value", async () => {
      const { storage, batch } = await prepareStorageTest<{
        items: LiveList<string>;
      }>(
        [
          createSerializedObject("0:0", {}),
          createSerializedList("0:1", "0:0", "items"),
        ],
        1
      );

      const items = storage.root.get("items");

      const numInserted = batch(() => {
        const before = items.length;
        items.push("A");
        items.push("B");
        items.push("C");
        return items.length - before;
      });

      expect(numInserted).toEqual(3);
    });

    it("calling undo during a batch should throw", async () => {
      const { undo, batch } = await prepareStorageTest<{ a: number }>(
        [createSerializedObject("0:0", { a: 0 })],
        1
      );

      batch(() => {
        expect(() => undo()).toThrow();
      });
    });

    it("calling redo during a batch should throw", async () => {
      const { batch, redo } = await prepareStorageTest<{ a: number }>(
        [createSerializedObject("0:0", { a: 0 })],
        1
      );

      batch(() => {
        expect(() => redo()).toThrow();
      });
    });
  });

  describe("undo / redo", () => {
    it("list.push", async () => {
      const { storage, expectStorage, assertUndoRedo } =
        await prepareStorageTest<{
          items: LiveList<string>;
        }>(
          [
            createSerializedObject("0:0", {}),
            createSerializedList("0:1", "0:0", "items"),
          ],
          1
        );

      const items = storage.root.get("items");

      expectStorage({ items: [] });

      items.push("A");
      expectStorage({
        items: ["A"],
      });

      items.push("B");
      expectStorage({
        items: ["A", "B"],
      });

      assertUndoRedo();
    });

    it("max undo-redo stack", async () => {
      const { storage, expectStorage, undo } = await prepareStorageTest<{
        a: number;
      }>([createSerializedObject("0:0", { a: 0 })], 1);

      for (let i = 0; i < 100; i++) {
        storage.root.set("a", i + 1);
        expectStorage({
          a: i + 1,
        });
      }

      for (let i = 0; i < 100; i++) {
        undo();
      }

      expectStorage({
        a: 50,
      });
    });

    it("storage operation should clear redo stack", async () => {
      const { storage, expectStorage, undo, redo } = await prepareStorageTest<{
        items: LiveList<string>;
      }>(
        [
          createSerializedObject("0:0", {}),
          createSerializedList("0:1", "0:0", "items"),
        ],
        1
      );

      const items = storage.root.get("items");

      expectStorage({ items: [] });

      items.insert("A", 0);
      expectStorage({
        items: ["A"],
      });

      undo();

      items.insert("B", 0);
      expectStorage({
        items: ["B"],
      });

      redo();

      expectStorage({
        items: ["B"],
      });
    });
  });
});
