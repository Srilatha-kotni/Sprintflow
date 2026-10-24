import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

let toastId = 0;

export function useToasts() {
  const [toasts, setToasts] = useState([]);
  const notify = useCallback((type, message) => {
    const id = ++toastId;
    setToasts((t) => [...t.slice(-3), { id, type, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), type === "error" ? 6000 : 3500);
  }, []);
  const dismiss = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  return { toasts, notify, dismiss };
}

// Calls `callback` every `ms` while `enabled`, always using the latest callback.
export function useInterval(callback, ms, enabled = true) {
  const saved = useRef(callback);
  useEffect(() => { saved.current = callback; }, [callback]);
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => saved.current(), ms);
    return () => clearInterval(id);
  }, [ms, enabled]);
}

// Browser speech-to-text that sends each finished sentence to the meeting as a note.
export function useSpeechNotes(token, notify) {
  const [listeningTo, setListeningTo] = useState(null); // meeting id
  const [interim, setInterim] = useState("");
  const recRef = useRef(null);
  const supported = typeof window !== "undefined" && ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);

  const send = useCallback(
    (meetingId, text) => api("/meetings/notes", { token, method: "POST", body: { meeting_id: meetingId, text } }),
    [token],
  );

  const stop = useCallback(() => {
    const rec = recRef.current;
    recRef.current = null;
    if (rec) {
      rec.onend = null;
      try { rec.stop(); } catch { /* already stopped */ }
    }
    setListeningTo(null);
    setInterim("");
  }, []);

  const start = useCallback((meetingId) => {
    if (!supported) return;
    stop();
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new Recognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";

    rec.onresult = (event) => {
      let finalText = "";
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const piece = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += piece;
        else interimText += piece;
      }
      setInterim(interimText);
      if (finalText.trim()) send(meetingId, finalText.trim()).catch((e) => notify("error", e.message));
    };
    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return; // quiet moment; onend restarts
      notify("error", e.error === "not-allowed"
        ? "Microphone access is blocked. Allow it from the icon in the address bar."
        : `Voice notes stopped (${e.error})`);
      stop();
    };
    // Browsers stop listening after a silence, so keep restarting while this recognizer is active
    rec.onend = () => {
      if (recRef.current === rec) {
        try { rec.start(); } catch { /* already started */ }
      }
    };

    recRef.current = rec;
    rec.start();
    setListeningTo(meetingId);
  }, [supported, stop, send, notify]);

  useEffect(() => stop, [stop]);

  return { supported, listeningTo, interim, start, stop, send };
}

// Promise-based confirm dialog: const ok = await confirm({ title, message, confirmLabel, danger })
export function useConfirm() {
  const [request, setRequest] = useState(null);
  const confirm = useCallback((options) => new Promise((resolve) => setRequest({ ...options, resolve })), []);
  const close = (answer) => {
    request?.resolve(answer);
    setRequest(null);
  };
  return { confirm, request, close };
}
