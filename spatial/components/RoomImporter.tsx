"use client";

import { useId, useState, type FormEvent } from "react";
import { MAX_ROOM_IMPORT_BYTES } from "../room/import-room";
import { importRoom, type RoomRecord } from "../rooms/registry";
import styles from "./RoomImporter.module.css";

type Props = { onImported: (room: RoomRecord) => void; onCancel?: () => void };

export function RoomImporter({ onImported, onCancel }: Props) {
  const id = useId();
  const [source, setSource] = useState<File | null>(null);
  const [model, setModel] = useState<File | null>(null);
  const [replaceModel, setReplaceModel] = useState(false);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!source || busy) return;
    setBusy(true); setError("");
    try {
      if (source.size > MAX_ROOM_IMPORT_BYTES) throw new Error("Choose a reconstruction JSON smaller than 2 MiB.");
      if (model && model.size > 64 * 1024 * 1024) throw new Error("Choose a matching room GLB smaller than 64 MiB.");
      const [body, bytes] = await Promise.all([source.arrayBuffer(), model?.arrayBuffer()]);
      const room = await importRoom(new TextDecoder("utf-8", { fatal: true }).decode(body), bytes, label, { replaceModel });
      onImported(room);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The room could not be imported. Try again."); }
    finally { setBusy(false); }
  }

  return <form className={styles.form} onSubmit={submit} aria-labelledby={`${id}-title`} aria-busy={busy}>
    <div className={styles.heading}>
      <div><p className={styles.eyebrow}>YOUR SPACE</p><h2 id={`${id}-title`}>Open your scan</h2></div>
      {onCancel ? <button className={styles.close} type="button" aria-label="Close scan importer" disabled={busy} onClick={onCancel}>×</button> : null}
    </div>
    <p className={styles.description}>Bring in your reconstructed room, then walk, rearrange and shop inside it.</p>
    <label className={styles.field} htmlFor={`${id}-name`}>Room name <span>optional</span>
      <input id={`${id}-name`} type="text" maxLength={120} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="My living room" disabled={busy} />
    </label>
    <label className={styles.field} htmlFor={`${id}-json`}>Reconstruction JSON
      <input id={`${id}-json`} type="file" accept=".json,application/json" required disabled={busy} onChange={(event) => { setSource(event.target.files?.[0] ?? null); setError(""); }} />
      <small>The reconstruction request with your measured room layout. Up to 2 MiB.</small>
    </label>
    <label className={styles.field} htmlFor={`${id}-model`}>Room model <span>optional</span>
      <input id={`${id}-model`} type="file" accept=".glb,model/gltf-binary" disabled={busy} onChange={(event) => { const file = event.target.files?.[0] ?? null; setModel(file); if (!file) setReplaceModel(false); setError(""); }} />
      <small>Choose the matching clean or photo-textured GLB, up to 64 MiB. Without it, furniture uses measured stand-ins.</small>
    </label>
    <div className={styles.modelUpdate}>
      <label htmlFor={`${id}-update-model`}><input id={`${id}-update-model`} type="checkbox" checked={replaceModel} disabled={busy || !model} aria-describedby={`${id}-update-help`} onChange={(event) => setReplaceModel(event.target.checked)} />Update the model for an existing scan</label>
      <p id={`${id}-update-help`}>Keeps your furniture edits and basket. Only updates a saved scan when the JSON and new GLB match its verified source.</p>
    </div>
    <p className={styles.privacy}>The model and photos stay in this browser. Entering the room shares its layout with the shopping service. Clearing site data removes saved imports.</p>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    <button className={styles.submit} type="submit" disabled={!source || busy}>{busy ? "Checking and saving room…" : replaceModel ? "Update model and enter room" : "Save and enter room"}</button>
    <p className={styles.status} role="status">{busy ? "Verifying the room and model match. Large models can take a moment." : ""}</p>
  </form>;
}

export default RoomImporter;
