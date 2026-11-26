import { useEffect, useState } from "react";

/**
 * True only once `flag` has stayed true for `ms`. Loaders use it so a wait that ends quickly never
 * shows anything: a spinner that flashes for 100 ms looks like a glitch, not like speed.
 */
export function useDelayedFlag(flag: boolean, ms: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!flag) {
      setShown(false);
      return;
    }
    const t = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(t);
  }, [flag, ms]);
  return flag && shown;
}
