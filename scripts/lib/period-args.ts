export type Period = {
  periodStart: Date;
  periodEnd: Date;
  label: string;
  clients?: string[];
};

function parseArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

function parseClients(): string[] | undefined {
  const raw = parseArg("clients");
  if (!raw) return undefined;
  return raw.split(",").map((c) => c.trim()).filter(Boolean);
}

export function parsePeriodArgs(): Period {
  const from = parseArg("from");
  const to = parseArg("to");
  const year = parseArg("year");
  const month = parseArg("month");

  let periodStart: Date;
  let periodEnd: Date;
  let label: string;

  if (from && to) {
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      throw new Error("Invalid --from or --to date.");
    }
    periodStart = new Date(Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), fromDate.getUTCDate(), 0, 0, 0, 0));
    periodEnd = new Date(Date.UTC(toDate.getUTCFullYear(), toDate.getUTCMonth(), toDate.getUTCDate(), 23, 59, 59, 999));
    label = `${periodStart.toISOString().slice(0, 10)}..${periodEnd.toISOString().slice(0, 10)}`;
  } else if (year && month) {
    const y = Number(year);
    const m = Number(month);
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
      throw new Error("Invalid --year or --month.");
    }
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    periodStart = new Date(Date.UTC(y, m - 1, 1));
    periodEnd = new Date(Date.UTC(y, m - 1, daysInMonth, 23, 59, 59, 999));
    label = `${y}-${String(m).padStart(2, "0")}`;
  } else {
    throw new Error("Provide --year and --month, or --from and --to.");
  }

  if (periodEnd < periodStart) {
    throw new Error("Period end must be after period start.");
  }

  return { periodStart, periodEnd, label, clients: parseClients() };
}

export function clientMatchesFilter(clientName: string, filter?: string[]) {
  if (!filter || filter.length === 0) return true;
  return filter.some((f) => clientName.includes(f) || f.includes(clientName));
}
