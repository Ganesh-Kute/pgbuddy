import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "owner-1" } }) }));
import { usePageData, deferSetters, applyTo } from "@/hooks/usePageData";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let server = { rooms: ["101", "102"] };
let fetches = 0;
let refresh: () => Promise<void> = async () => {};

/** A page written the way the converted pages are: rows in local state, loader queues the sets. */
function RoomsPage() {
  const [rooms, setRooms] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const load = async () => {
    const later = deferSetters<typeof setters>();
    fetches++;
    const rows = [...server.rooms];
    await Promise.resolve();
    later((s) => s.setRooms(rows));
    later((s) => s.setLoading(false));
    return later.commits;
  };
  const setters = { setRooms, setLoading };
  ({ refresh } = usePageData(["Rooms"], load, applyTo(setters)));
  return <p>{loading ? "loading" : rooms.join(",")}</p>;
}

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));
function mount(client: QueryClient) {
  const el = document.createElement("div");
  let root: Root;
  act(() => { root = createRoot(el); root.render(<QueryClientProvider client={client}><RoomsPage /></QueryClientProvider>); });
  return { el, unmount: () => act(() => root.unmount()) };
}

beforeEach(() => { server = { rooms: ["101", "102"] }; fetches = 0; });

describe("usePageData", () => {
  it("loads on first visit", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000 } } });
    const page = mount(client);
    expect(page.el.textContent).toBe("loading");
    await flush();
    expect(page.el.textContent).toBe("101,102");
    expect(fetches).toBe(1);
  });

  it("renders a revisited page from the cache at once, without fetching (the remount bug)", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000 } } });
    const first = mount(client);
    await flush();
    first.unmount();
    const again = mount(client); // a new instance with new setters
    expect(again.el.textContent).toBe("101,102"); // before paint: no loading flash
    await flush();
    expect(fetches).toBe(1);
  });

  it("refresh() refetches after a write and shows the new rows", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000 } } });
    const page = mount(client);
    await flush();
    server.rooms = ["101", "102", "103"];
    await act(() => refresh());
    await flush();
    expect(page.el.textContent).toBe("101,102,103");
    expect(fetches).toBe(2);
  });

  it("refresh() marks other pages stale, so they refetch on their next visit", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000 } } });
    client.setQueryData(["page-data", "owner-1", "Dashboard"], [], { updatedAt: Date.now() });
    const page = mount(client);
    await flush();
    await act(() => refresh());
    expect(client.getQueryState(["page-data", "owner-1", "Dashboard"])?.isInvalidated).toBe(true);
    page.unmount();
  });
});
