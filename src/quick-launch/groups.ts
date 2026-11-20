import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { check } from "../domain/errors.js";
import { canonicalJson } from "../persistence/files.js";
import type { Store } from "../persistence/store.js";

export type GroupChange = { name: string; parentId: string | null; requestId: string };
type Group = { id: string; name: string; parentId: string | null; revision: number };
type DeleteGroup = { requestId: string; destinationGroupId: string | null; previewToken: string };

export class QuickLaunchGroups {
  private readonly previewKey = randomBytes(32);
  constructor(private readonly store: Store) {}

  private sign(state: ReturnType<QuickLaunchGroups["deletionState"]>, expiry: number) {
    return createHmac("sha256", this.previewKey).update(canonicalJson({ state, expiry })).digest("hex");
  }

  private validPreview(token: string, state: ReturnType<QuickLaunchGroups["deletionState"]>) {
    if (!/^\d{13}\.[a-f0-9]{64}$/.test(token)) return false;
    const [time, signature] = token.split(".");
    const expiry = Number(time);
    return expiry > Date.now() && timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(this.sign(state, expiry), "hex"));
  }

  list() {
    return this.store.all<Group>(`SELECT id, name, parent_id AS parentId, revision
      FROM quick_launch_groups ORDER BY name_key, id`);
  }

  create(input: GroupChange) {
    return this.store.command("quick-launch-groups:create", input.requestId, input, () => {
      const name = this.name(input.name);
      this.validatePlacement(null, name, input.parentId);
      const id = randomUUID(), now = Date.now();
      this.store.exec("INSERT INTO quick_launch_groups VALUES (?,?,?,?,1,?,?)", id, name, name, input.parentId, now, now);
      return { id, name, parentId: input.parentId, revision: 1 };
    });
  }

  update(id: string, input: GroupChange & { revision: number }) {
    return this.store.command(`quick-launch-groups:update:${id}`, input.requestId, input, () => {
      const current = this.requireGroup(id);
      check(current.revision === input.revision, "REVISION_CONFLICT", "分组已更新，请重新加载", 409);
      const name = this.name(input.name);
      this.validatePlacement(id, name, input.parentId);
      this.store.exec(`UPDATE quick_launch_groups SET name=?, name_key=?, parent_id=?, revision=revision+1,
        updated_at=? WHERE id=? AND revision=?`, name, name, input.parentId, Date.now(), id, input.revision);
      return { id, name, parentId: input.parentId, revision: input.revision + 1 };
    });
  }

  preview(id: string) {
    return this.store.transaction(() => {
      const state = this.deletionState(id);
      const expiry = Date.now() + 5 * 60_000;
      return {
        descendantCount: state.groups.length - 1,
        cardCount: state.cards.length,
        destinations: state.destinations,
        previewToken: `${expiry}.${this.sign(state, expiry)}`
      };
    });
  }

  delete(id: string, input: DeleteGroup) {
    return this.store.command(`quick-launch-groups:delete:${id}`, input.requestId, input, () => {
      const state = this.deletionState(id);
      check(this.validPreview(input.previewToken, state), "PREVIEW_STALE", "分组或卡片已变化，请重新预览", 409);
      check(input.destinationGroupId === null || state.destinations.some(group => group.id === input.destinationGroupId),
        "INVALID_DESTINATION", "请选择子树以外的目标分组");
      const now = Date.now();
      for (const group of state.groups) {
        this.store.exec("UPDATE quick_launches SET group_id=?, revision=revision+1, updated_at=? WHERE group_id=?",
          input.destinationGroupId, now, group.id);
        this.store.exec("DELETE FROM quick_launch_groups WHERE id=?", group.id);
      }
      return { deletedGroups: state.groups.length, deletedGroupIds: state.groups.map(group => group.id), movedCards: state.cards.length };
    });
  }

  private name(value: string) {
    const name = value.trim().normalize("NFC");
    const length = Array.from(name).length;
    check(length >= 1 && length <= 40 && !/[\/\u0000]/.test(name), "INVALID_GROUP_NAME", "分组名需为 1–40 字，不得包含斜杠");
    return name;
  }

  private requireGroup(id: string) {
    const group = this.store.one<Group>("SELECT id, name, parent_id AS parentId, revision FROM quick_launch_groups WHERE id=?", id);
    check(group, "NOT_FOUND", "分组不存在", 404);
    return group;
  }

  private descendants(id: string) {
    return this.store.all<Group & { depth: number }>(`WITH RECURSIVE tree(id, depth) AS (
      SELECT ?, 1 UNION ALL SELECT g.id, t.depth+1 FROM quick_launch_groups g JOIN tree t ON g.parent_id=t.id WHERE t.depth<6
    ) SELECT g.id, g.name, g.parent_id AS parentId, g.revision, t.depth
      FROM tree t JOIN quick_launch_groups g ON g.id=t.id ORDER BY t.depth DESC, g.id`, id);
  }

  private validatePlacement(id: string | null, name: string, parentId: string | null) {
    let depth = 0, ancestor = parentId;
    while (ancestor !== null) {
      check(ancestor !== id && depth < 5, "INVALID_GROUP_PARENT", "不能移到自身或子分组，且分组最多五层");
      ancestor = this.requireGroup(ancestor).parentId;
      depth++;
    }
    const subtreeDepth = id === null ? 1 : (this.descendants(id)[0]?.depth ?? 1);
    check(depth + subtreeDepth <= 5, "GROUP_DEPTH", "分组最多五层");
    check(!this.store.one("SELECT id FROM quick_launch_groups WHERE parent_id IS ? AND name_key=? AND id IS NOT ?",
      parentId, name, id), "DUPLICATE_GROUP", "同级已有此名称", 409);
  }

  private deletionState(id: string) {
    this.requireGroup(id);
    const groups = this.descendants(id);
    const ids = new Set(groups.map(group => group.id));
    const cards = groups.flatMap(group => this.store.all<{ id: string; revision: number }>(
      "SELECT id, revision FROM quick_launches WHERE group_id=? ORDER BY id", group.id));
    const destinations = this.list().filter(group => !ids.has(group.id));
    return { groups, cards, destinations };
  }
}
