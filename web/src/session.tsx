import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type Config, type Role } from "./api.ts";

type Session = { role: Role | null; name: string | null; config: Config | null; login: (r: Role, code?: string) => Promise<void>; logout: () => Promise<void> };
const Ctx = createContext<Session>(null!);
export const useSession = () => useContext(Ctx);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [role, setRole] = useState<Role | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  useEffect(() => {
    api("GET", "/api/auth/me").then((r) => { setRole(r.role); setName(r.user?.name ?? null); });
    api<Config>("GET", "/api/config").then(setConfig);
  }, []);
  const login = async (r: Role, code?: string) => {
    const out = await api("POST", "/api/auth/login", { role: r, code });
    setRole(out.role);
    setName(out.user.name);
  };
  const logout = async () => {
    await api("POST", "/api/auth/logout");
    setRole(null);
    setName(null);
  };
  return <Ctx.Provider value={{ role, name, config, login, logout }}>{children}</Ctx.Provider>;
}
