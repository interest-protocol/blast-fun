"use client";

import { diagnosticMessage, publicErrorMessage } from "#web/lib/errors.ts";
import { isEnterSubmit } from "#web/lib/ime-enter.ts";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { Sheet, SheetClose, SheetHeading } from "#web/components/blast-ui/Sheet.tsx";
import { TextArea } from "#web/components/blast-ui/TextField.tsx";
import { queryKeys } from "#web/lib/query/keys.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { PROFILE_PICTURE_MAX_BYTES, type SocialProfileEdit, type SocialProfileEditRequest } from "@blast/core/web/contracts/profile-page.ts";
import { normalizeProfileBio, PROFILE_BIO_MAX } from "@blast/core/web/contracts/profiles.ts";

import { profileEditQuery } from "../queries";
import { CallsignField } from "../onboarding/CallsignField";
import { useCallsignInput } from "../onboarding/use-callsign-input";
import type { ApiResult, SocialApiOptions } from "#web/components/social/social-api.ts";
import styles from "./Profile.module.css";
import { UploadIcon } from "./icons";
import { Avatar } from "./parts";
import { editRefusalMessage, nameCheck, preparePicture, type PictureChange } from "./edit-profile";
import { saveProfileEdit, uploadProfilePicture } from "./profile-client";

/** A small image as a `data:` URL, or null when it cannot be read. */
function dataUrlOf(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

export type ProfileEditDraft = Readonly<{ name: string | null; picture: PictureChange; callsign?: string; bio?: string }>;
type ProfileEditSaveResult = string | Readonly<{ message: string; saved: SocialProfileEdit }> | null;
const noToken = async () => null;

/**
 * "Edit profile" (OA-14; OA-44 rebuilt it on the gate's sheet,
 * `blast-trading-home-oa43.html` `openEditProfile`): the own profile's sheet
 * for the picture and profile details (Settings has no profile
 * fields). The avatar is the upload control, with the gate's upload badge
 * (when a picture store is configured). OA-13's two other picture choices stay,
 * as quiet small buttons under the "Profile picture" text (the gate's own way to
 * act on a picture: the Create sheet's "Cover image" row): switch back to the
 * account's X or Mission Control picture (when it has one: a wallet-only account
 * has none), or remove it (the generated avatar). Changes are staged and saved
 * together; `onSave` answers an error with any acknowledged progress, or null when saved.
 */
function pictureView(edit: SocialProfileEdit | null, picture: PictureChange, avatarUrl: string | null) {
  let preview = edit ? edit.avatar_url : avatarUrl;
  switch (picture.kind) {
    case "upload": preview = picture.preview; break;
    case "source": preview = edit?.source_avatar_url ?? null; break;
    case "none": preview = null; break;
  }
  const shownChoice = picture.kind === "keep" ? edit?.picture ?? "source" : picture.kind;
  return {
    preview,
    canUpload: edit?.upload_available === true,
    canUseSource: Boolean(edit?.source_avatar_url) && shownChoice !== "source",
    canRemove: edit !== null && shownChoice !== "none" && preview !== null,
  };
}

function useInitialReadyNameFocus(open: boolean, initial: SocialProfileEdit | null) {
  const nameInput = useRef<HTMLInputElement>(null);
  // Once the account's values arrive, the name field takes focus (it was disabled while loading).
  useEffect(() => {
    if (!open || !initial) return;
    const input = nameInput.current;
    if (input && (document.activeElement === null || document.activeElement === document.body || document.activeElement.getAttribute("role") === "dialog")) {
      input.focus({ preventScroll: true });
    }
  }, [open, initial]);
  return nameInput;
}

function profileDraftChecks(edit: SocialProfileEdit | null, name: string, callsign: string, callsignInput: ReturnType<typeof useCallsignInput>) {
  const check = nameCheck(name, edit?.callsign_editable ? undefined : callsign);
  const nameChanged = edit !== null && name.trim() !== (edit.display_name ?? "");
  const callsignChanged = edit?.callsign_editable === true && callsignInput.value !== (edit.callsign ?? callsign);
  const callsignReady = edit?.callsign_editable !== true || callsignInput.ready;
  return { check, nameChanged, callsignChanged, callsignReady };
}

function profileTextDraft(edit: SocialProfileEdit | null) {
  return { name: edit?.display_name ?? "", bio: edit?.bio ?? "" };
}

function useEditSheetViewControls({
  open,
  callsign,
  initial,
  avatarUrl = null,
  loadError = null,
  onClose,
  onSave,
  getAccessToken = noToken,
}: Readonly<{
  open: boolean;
  callsign: string;
  /** What the sheet shows; null while it loads. */
  initial: SocialProfileEdit | null;
  /** The avatar the page shows, drawn while `initial` loads so the picture does not flash the generated one. */
  avatarUrl?: string | null;
  loadError?: string | null;
  onClose: () => void;
  onSave: (draft: ProfileEditDraft) => Promise<ProfileEditSaveResult>;
  getAccessToken?: () => Promise<string | null>;
}>) {
  const [{ name, bio }, setTextDraft] = useState(() => profileTextDraft(initial));
  const [seen, setSeen] = useState(initial);
  const [acknowledged, setAcknowledged] = useState(initial);
  const [picture, setPicture] = useState<PictureChange>({ kind: "keep" });
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const edit = acknowledged;
  const callsignInput = useCallsignInput(edit?.callsign ?? callsign, getAccessToken);

  // A new answer (another opening) resets the form.
  if (initial !== seen) {
    setSeen(initial);
    setAcknowledged(initial);
    setTextDraft(profileTextDraft(initial));
    setPicture({ kind: "keep" });
    setMessage(null);
  }

  const nameInput = useInitialReadyNameFocus(open, initial);

  const ready = edit !== null;
  const { check, nameChanged, callsignChanged, callsignReady } = profileDraftChecks(edit, name, callsign, callsignInput);
  const bioLength = [...bio].length;
  const badBio = bioLength > PROFILE_BIO_MAX;
  const bioChanged = normalizeProfileBio(bio) !== (edit?.bio ?? "");
  const changed = nameChanged || picture.kind !== "keep" || callsignChanged || bioChanged;
  const { preview, canUpload, canUseSource, canRemove } = pictureView(edit, picture, avatarUrl);
  const bad = ready && check.state === "bad";
  const canSave = ready && changed && !bad && !badBio && callsignReady && !saving;

  function resetDraft() {
    setTextDraft(profileTextDraft(edit));
    setPicture({ kind: "keep" });
    setMessage(null);
    callsignInput.onChange(edit?.callsign ?? callsign);
  }

  function setProfileText(field: "name" | "bio", value: string) {
    setTextDraft((draft) => ({ ...draft, [field]: value }));
  }

  async function choose(input: HTMLInputElement) {
    const chosen = input.files?.[0];
    input.value = "";
    if (!chosen) return;
    setMessage(null);
    const prepared = await preparePicture(chosen, PROFILE_PICTURE_MAX_BYTES);
    if (!prepared.ok) {
      setMessage(diagnosticMessage(prepared.message, { code: "invalid_request" }));
      return;
    }
    // The preview is the prepared image as a data URL (the gate's `readAsDataURL`), which the avatar draws; an object URL it would not.
    const preview = await dataUrlOf(prepared.blob);
    if (preview === null) {
      setMessage(diagnosticMessage("This image could not be read. Try another one.", { code: "invalid_request" }));
      return;
    }
    setPicture({ kind: "upload", blob: prepared.blob, preview });
  }

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setMessage(null);
    return await (async () => {
      const error = await onSave({
        name: nameChanged ? name : null,
        picture,
        ...(callsignChanged ? { callsign: callsignInput.value } : {}),
        ...(bioChanged ? { bio } : {}),
      });
      if (error !== null) {
        if (typeof error === "string") setMessage(error);
        else {
          // Advance the saved comparison without discarding the entered text or staged photo.
          setAcknowledged(error.saved);
          setMessage(error.message);
        }
        return;
      }
      onClose();
    })().catch((error: unknown) => {
      setMessage(publicErrorMessage(error, "The update could not be confirmed. Check your profile and try again."));
    }).finally(() => {
      setSaving(false);
    });
  }

  // The avatar is a label around the file field (the gate's `label.ep-av`): a press opens the picker, and so do Enter and Space.
  const picking = !ready || saving;
  const openPicker = (event: KeyboardEvent<HTMLLabelElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (!picking) event.currentTarget.querySelector("input")?.click();
  };

  const nameMessage = ready ? check.message : "";
  return { open, callsign, loadError, onClose, resetDraft, name, bio, setProfileText, bioLength, badBio, setPicture, message, saving, nameInput, ready, preview, canUpload, canUseSource, canRemove, bad, canSave, choose, save, picking, openPicker, callsignInput, nameMessage, callsignEditable: edit?.callsign_editable === true };
}

export function EditSheetView(props: Parameters<typeof useEditSheetViewControls>[0]) {
  const { open, callsign, loadError, onClose, resetDraft, name, bio, setProfileText, bioLength, badBio, setPicture, message, saving, nameInput, ready, preview, canUpload, canUseSource, canRemove, bad, canSave, choose, save, picking, openPicker, callsignInput, callsignEditable, nameMessage } = useEditSheetViewControls(props);
  return (
    <Sheet className={styles.epSheet} initialFocus={() => nameInput.current} labelledBy="edit-profile-title" onClosed={resetDraft} onRequestClose={onClose} open={open}>
      <SheetClose onClick={onClose} />
      <SheetHeading id="edit-profile-title" title="Edit profile" />
      {loadError ? (
        <p className={styles.msg} data-tone="bad" role="alert">
          {loadError}
        </p>
      ) : null}
      <ProfilePictureEditor canUpload={canUpload} callsign={callsign} preview={preview} openPicker={openPicker} picking={picking} choose={choose} ready={ready} canUseSource={canUseSource} canRemove={canRemove} saving={saving} setPicture={setPicture} />
      <div className={styles.field}>
        <label htmlFor="edit-profile-name">Display name</label>
        <div className={styles.input}>
          <input
            aria-describedby="edit-profile-name-msg"
            aria-invalid={bad || undefined}
            autoComplete="nickname"
            disabled={!ready || saving}
            id="edit-profile-name"
            maxLength={64}
            onChange={(event) => setProfileText("name", event.currentTarget.value)}
            onKeyDown={(event) => {
              if (isEnterSubmit(event)) void save();
            }}
            ref={nameInput}
            spellCheck={false}
            value={name}
          />
        </div>
        <p aria-live="polite" className={styles.msg} data-tone={bad ? "bad" : undefined} id="edit-profile-name-msg">
          {nameMessage}
        </p>
      </div>
      {callsignEditable ? <>
        <CallsignField check={callsignInput.check} disabled={saving} onChange={callsignInput.onChange} value={callsignInput.value} />
        <p className={styles.msg}>Changing your call sign changes your profile URL. Previous links will still work.</p>
      </> : null}
      <div className={styles.field}>
        <label htmlFor="edit-profile-bio">Bio</label>
        <TextArea
          aria-describedby="edit-profile-bio-hint"
          aria-invalid={badBio || undefined}
          dir="auto"
          disabled={!ready || saving}
          id="edit-profile-bio"
          onChange={(event) => setProfileText("bio", event.currentTarget.value)}
          resize="none"
          rows={2}
          value={bio}
        />
        <p className={styles.msg} data-tone={badBio ? "bad" : undefined} id="edit-profile-bio-hint">
          {badBio ? null : <span>Public · {bioLength}/{PROFILE_BIO_MAX} characters</span>}
          <span aria-live="polite">{badBio ? `Use at most ${PROFILE_BIO_MAX} characters.` : null}</span>
        </p>
      </div>
      {message ? <p className={styles.msg} data-tone="bad" role="alert">{message}</p> : null}
      <button aria-describedby={badBio ? "edit-profile-bio-hint" : undefined} className="btn btn-primary btn-lg btn-block" disabled={!canSave} onClick={() => void save()} type="button">
        {saving ? (
          <>
            <span aria-hidden="true" className={styles.spin} />
            Saving
          </>
        ) : (
          "Save"
        )}
      </button>
    </Sheet>
  );
}

/** The edit sheet wired to `GET`/`PUT /api/social/me/profile` and the picture upload. */
export function EditProfileSheet({
  open,
  callsign,
  avatarUrl,
  api,
  onClose,
  onSaved,
}: Readonly<{
  open: boolean;
  callsign: string;
  avatarUrl: string | null;
  api: SocialApiOptions;
  onClose: () => void;
  onSaved: (edit: SocialProfileEdit) => void;
}>) {
  const queries = useAppQueryClient();
  const [edit, setEdit] = useState<SocialProfileEdit | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    // Read on every opening, through the shared cache (OA-38).
    queries.fetchQuery({ ...profileEditQuery(api.getAccessToken), staleTime: 0 }).then(
      (body) => {
        if (!live) return;
        setLoadError(null);
        setEdit(body);
      },
      (error: unknown) => {
        if (live) setLoadError(publicErrorMessage(error, "Your profile could not load. Close this and try again."));
      },
    );
    return () => {
      live = false;
    };
    // Read once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function failedPhotoSave(result: Exclude<ApiResult<SocialProfileEdit>, { status: "ok" }>, latest: SocialProfileEdit | null): ProfileEditSaveResult {
    if (latest === edit || !latest) return result.status === "error"
      ? diagnosticMessage("Your photo update could not be confirmed. Check your profile before trying again.", result)
      : editRefusalMessage(result);
    queries.setQueryData(queryKeys.me.profileEdit(), latest);
    onSaved(latest);
    // Advance acknowledged details independently from the opening snapshot, which resets drafts.
    return { saved: latest, message: diagnosticMessage(result.status === "error"
      ? "Your profile details were saved, but your photo update could not be confirmed. Check your profile before trying again."
      : "Your profile details were saved, but your photo was not saved. Try again or choose another photo.", result) };
  }

  async function save(draft: ProfileEditDraft): Promise<ProfileEditSaveResult> {
    let latest = edit;
    const change: SocialProfileEditRequest = {
      ...(draft.callsign !== undefined ? { callsign: draft.callsign } : {}),
      ...(draft.name !== null ? { display_name: draft.name } : {}),
      ...(draft.bio !== undefined ? { bio: draft.bio } : {}),
      ...(draft.picture.kind === "source" || draft.picture.kind === "none" ? { picture: draft.picture.kind } : {}),
    };
    if (Object.keys(change).length > 0) {
      const saved = await saveProfileEdit(api, change);
      if (saved.status === "error") return diagnosticMessage("Your profile update could not be confirmed. Check your profile and try again.", saved);
      if (saved.status !== "ok") return editRefusalMessage(saved);
      latest = saved.body;
    }
    // Refuse invalid profile details before committing a replacement photo.
    if (draft.picture.kind === "upload") {
      const uploaded = await uploadProfilePicture(api, draft.picture.blob);
      if (uploaded.status !== "ok") return failedPhotoSave(uploaded, latest);
      latest = uploaded.body;
    }
    if (latest) {
      // The save's answer is the editor's read now (OA-38); the account avatar's `me` is refreshed by the page.
      queries.setQueryData(queryKeys.me.profileEdit(), latest);
      setEdit(latest);
      onSaved(latest);
    }
    return null;
  }

  return <EditSheetView avatarUrl={avatarUrl} callsign={edit?.callsign ?? callsign} getAccessToken={api.getAccessToken} initial={edit} loadError={loadError} onClose={onClose} onSave={save} open={open} />;
}

function ProfilePictureEditor({ canUpload, callsign, preview, openPicker, picking, choose, ready, canUseSource, canRemove, saving, setPicture }: Pick<ReturnType<typeof useEditSheetViewControls>, "canUpload" | "callsign" | "preview" | "openPicker" | "picking" | "choose" | "ready" | "canUseSource" | "canRemove" | "saving" | "setPicture">) {
  return (
      <div className={styles.epPhoto}>
        {canUpload ? (
          <label className={styles.epAv} onKeyDown={openPicker} tabIndex={0} title="Change picture">
            <Avatar seed={callsign} size={89} url={preview} />
            <input
              accept="image/png,image/jpeg,image/webp"
              disabled={picking}
              hidden
              onChange={(event) => void choose(event.currentTarget)}
              type="file"
            />
            <span aria-hidden="true" className={styles.epBadge}>
              <UploadIcon />
            </span>
            <span className="sr">Change picture</span>
          </label>
        ) : (
          <span className={styles.epAv}>
            <Avatar seed={callsign} size={89} url={preview} />
          </span>
        )}
        <div className={styles.epT}>
          <b>Profile picture</b>
          <span>{canUpload || !ready ? "PNG, JPG or WebP, up to 2 MB." : "Photo uploads are not available right now."}</span>
          {canUseSource || canRemove ? (
            <div className={styles.epActs}>
              {canUseSource ? (
                <button className="btn btn-quiet btn-sm" disabled={saving} onClick={() => setPicture({ kind: "source" })} type="button">
                  Use X photo
                </button>
              ) : null}
              {canRemove ? (
                <button className="btn btn-quiet btn-sm" disabled={saving} onClick={() => setPicture({ kind: "none" })} type="button">
                  Remove photo
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

  );
}
