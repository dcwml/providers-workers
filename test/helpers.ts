import type { D1Database, ExecutionContext } from "@cloudflare/workers-types";

export interface RecordedStatement {
  sql: string;
  params: unknown[];
  method: "first" | "run" | "all";
}

export interface FakeD1Handle {
  db: D1Database;
  /** 按 prepare(sql) 调用顺序记录的语句（含 bind 后参数） */
  statements: RecordedStatement[];
  /** 按 SQL 精确键设置 first()/all() 的返回行 */
  setRows(sql: string, rows: Record<string, unknown>[]): void;
  /** 按 SQL 精确键覆盖 run() 的 meta（默认 { changes: 1, last_row_id: 1 }） */
  setRunMeta(sql: string, meta: Record<string, unknown>): void;
  /** 命中 SQL 子串时让该语句抛错（模拟 D1 故障/约束冲突）；substring 传 null 清除 */
  failOnSubstring(substring: string | null, message?: string): void;
}

export function makeFakeD1(): FakeD1Handle {
  const rowsBySql = new Map<string, Record<string, unknown>[]>();
  const metaBySql = new Map<string, Record<string, unknown>>();
  const statements: RecordedStatement[] = [];
  let failOn: string | null = null;
  let failMessage = "simulated d1 failure";

  function maybeFail(sql: string): void {
    if (failOn !== null && sql.includes(failOn)) {
      throw new Error(failMessage);
    }
  }

  function makeStmt(sql: string, params: unknown[]): Record<string, unknown> {
    return {
      bind: (...values: unknown[]) => makeStmt(sql, [...params, ...values]),
      first: async (): Promise<unknown> => {
        statements.push({ sql, params, method: "first" });
        maybeFail(sql);
        const rows = rowsBySql.get(sql);
        const row = rows === undefined ? undefined : rows[0];
        return row === undefined ? null : row;
      },
      run: async (): Promise<{ success: true; meta: Record<string, unknown> }> => {
        statements.push({ sql, params, method: "run" });
        maybeFail(sql);
        const meta = metaBySql.get(sql) ?? { changes: 1, last_row_id: 1 };
        return { success: true, meta };
      },
      all: async (): Promise<{ results: Record<string, unknown>[]; success: true }> => {
        statements.push({ sql, params, method: "all" });
        maybeFail(sql);
        return { results: rowsBySql.get(sql) ?? [], success: true };
      },
    };
  }

  const db = { prepare: (sql: string) => makeStmt(sql, []) } as unknown as D1Database;

  return {
    db,
    statements,
    setRows: (sql, rows) => rowsBySql.set(sql, rows),
    setRunMeta: (sql, meta) => metaBySql.set(sql, meta),
    failOnSubstring: (substring, message) => {
      failOn = substring;
      failMessage = message ?? "simulated d1 failure";
    },
  };
}

export interface FakeCtxHandle {
  ctx: ExecutionContext;
  /** waitUntil 收到的 promise；测试里 await Promise.all(handle.promises) 确认落库完成且不抛错 */
  promises: Promise<unknown>[];
}

export function makeFakeCtx(): FakeCtxHandle {
  const promises: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>): void => {
      promises.push(p);
    },
  } as unknown as ExecutionContext;
  return { ctx, promises };
}
