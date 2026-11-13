import { useCallback, useEffect, useState } from "react";
import {
  applyPreferenceImport,
  LEGACY_STRATEGIES,
  LEGACY_WATCH,
  PREF_KEY,
  preferenceView,
  writePreferences,
} from "./preferences.js";

export function usePreferences() {
  const [value, setValue] = useState(() => preferenceView(localStorage));
  const reload = useCallback(() => setValue(preferenceView(localStorage)), []);
  useEffect(() => {
    const onStorage = (e) => {
      if (
        e.storageArea === localStorage &&
        [null, PREF_KEY, LEGACY_STRATEGIES, LEGACY_WATCH].includes(e.key)
      )
        reload();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [reload]);
  const commit = useCallback(
    async (work) => {
      try {
        if (navigator.locks)
          await navigator.locks.request(PREF_KEY, () => work(localStorage));
        else work(localStorage);
      } finally {
        reload();
      }
    },
    [reload],
  );
  return {
    ...value,
    edit: (update) => commit((storage) => writePreferences(storage, update)),
    restore: (draft) =>
      commit((storage) => applyPreferenceImport(storage, draft)),
  };
}
