export const fmt = (time: number | null) => time == null ? "—" : new Date(time).toLocaleString();
