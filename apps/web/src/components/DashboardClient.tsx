"use client";

import { ChangeEvent, DragEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { inferMimeFromFilename, isUploadConversionSupported } from "@/lib/jobs";
import type { SerializedJob } from "@/lib/serialize";

type Props = {
  clientIp: string;
  authRequired: boolean;
  initialJobs: SerializedJob[];
  captchaEnabled: boolean;
  captchaSiteKey: string;
};

type SourceMode = "url" | "file";
type UrlMediaMode = "audio" | "video";
type FileMediaMode = "audio" | "video" | "other";
type MediaMode = UrlMediaMode | FileMediaMode;
type SupportedServiceId = "youtube" | "soundcloud" | "vimeo" | "bandcamp";

const AUDIO_OUTPUTS = ["mp3", "aac", "ogg", "wav"] as const;
const VIDEO_OUTPUTS = ["mp4", "webm", "mkv"] as const;
const OTHER_FILE_OUTPUTS = ["pdf", "docx", "txt"] as const;
const SUPPORTED_URL_SERVICES: { id: SupportedServiceId; label: string }[] = [
  { id: "youtube", label: "YouTube" },
  { id: "soundcloud", label: "SoundCloud" },
  { id: "vimeo", label: "Vimeo" },
  { id: "bandcamp", label: "Bandcamp" },
];

function ServiceIcon({ service }: { service: SupportedServiceId }) {
  if (service === "youtube") {
    return (
      <svg className="service-icon" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="2" y="4.5" width="20" height="15" rx="4.8" fill="#FF0033" />
        <path d="M10.15 8.9L16.35 12L10.15 15.1V8.9Z" fill="#FFFFFF" />
      </svg>
    );
  }

  if (service === "soundcloud") {
    return (
      <svg className="service-icon" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="2" y="2" width="20" height="20" rx="5" fill="#FF6A1A" />
        <path d="M7.1 15.6A2.6 2.6 0 0 1 9.5 12a3 3 0 0 1 5.75.95 2.1 2.1 0 0 1 .85-.18 2.4 2.4 0 1 1 0 4.8H8.05a2.45 2.45 0 0 1-.95-1.97Z" fill="#FFFFFF" />
        <rect x="5.2" y="14.6" width="1.2" height="3" rx="0.6" fill="#FFFFFF" />
        <rect x="6.9" y="13.6" width="1.2" height="4" rx="0.6" fill="#FFFFFF" />
      </svg>
    );
  }

  if (service === "vimeo") {
    return (
      <svg className="service-icon" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="2" y="2" width="20" height="20" rx="5" fill="#19B7EA" />
        <path d="M6.35 9.95C7.4 9.05 8.1 8.58 8.47 8.58c.45 0 .72.33.8.98.09.75.22 1.66.4 2.74.18 1.08.42 1.62.72 1.62.23 0 .58-.37 1.06-1.11.48-.74.73-1.31.76-1.72.07-.65-.19-.98-.78-.98-.28 0-.57.06-.86.18.57-1.87 1.67-2.77 3.3-2.71 1.2.04 1.76.88 1.69 2.53-.04 1.08-.62 2.29-1.74 3.64-1.12 1.35-2.07 2.03-2.84 2.03-.48 0-.89-.44-1.22-1.33-.22-.82-.45-1.64-.67-2.46-.25-.89-.52-1.33-.82-1.33-.06 0-.29.14-.69.42l-.41-.5Z" fill="#FFFFFF" />
      </svg>
    );
  }

  return (
    <svg className="service-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" rx="5" fill="#5DD0D2" />
      <path d="M6 7H13.1L18 17H10.9L6 7Z" fill="#FFFFFF" />
      <path d="M9.9 7H13.1L18 17H14.85L9.9 7Z" fill="#2C7481" opacity="0.35" />
    </svg>
  );
}

function outputFallback(media: MediaMode) {
  if (media === "audio") return AUDIO_OUTPUTS[0];
  if (media === "video") return VIDEO_OUTPUTS[0];
  return OTHER_FILE_OUTPUTS[0];
}

function isOutputCompatible(format: string, media: MediaMode) {
  if (media === "audio") return AUDIO_OUTPUTS.includes(format as (typeof AUDIO_OUTPUTS)[number]);
  if (media === "video") return VIDEO_OUTPUTS.includes(format as (typeof VIDEO_OUTPUTS)[number]);
  return OTHER_FILE_OUTPUTS.includes(format as (typeof OTHER_FILE_OUTPUTS)[number]);
}

function statusLabel(job: SerializedJob) {
  if (job.status === "queued" && job.attemptCount > 0 && job.attemptCount < job.maxAttempts) {
    return `retry ${job.attemptCount}/${job.maxAttempts}`;
  }

  if (job.status === "processing") {
    return `attempt ${job.attemptCount || 1}/${job.maxAttempts || 1}`;
  }

  if (job.status === "failed" && job.maxAttempts > 1) {
    return `exhausted ${job.attemptCount}/${job.maxAttempts}`;
  }

  return job.status;
}

export function DashboardClient({ clientIp, authRequired, initialJobs, captchaEnabled, captchaSiteKey }: Props) {
  const [jobs, setJobs] = useState(initialJobs);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingUrl, setLoadingUrl] = useState(false);
  const [loadingUpload, setLoadingUpload] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragActive, setIsDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [activeSource, setActiveSource] = useState<SourceMode>("url");
  const [urlMedia, setUrlMedia] = useState<UrlMediaMode>("audio");
  const [fileMedia, setFileMedia] = useState<FileMediaMode>("audio");

  const [urlForm, setUrlForm] = useState({
    url: "",
    outputFormat: "mp3",
    audioQuality: "standard",
    videoQuality: "p720",
    captchaToken: "",
  });

  const [uploadForm, setUploadForm] = useState({
    outputFormat: "mp3",
    audioQuality: "standard",
    videoQuality: "p720",
  });

  const activeCount = useMemo(() => jobs.filter((job) => ["queued", "processing"].includes(job.status)).length, [jobs]);
  const activeMedia = activeSource === "url" ? urlMedia : fileMedia;
  const sourceIndex = activeSource === "url" ? 0 : 1;
  const mediaCount = activeSource === "file" ? 3 : 2;
  const mediaIndex =
    activeSource === "url"
      ? urlMedia === "audio"
        ? 0
        : 1
      : fileMedia === "audio"
        ? 0
        : fileMedia === "video"
          ? 1
          : 2;
  const outputOptions = activeMedia === "audio" ? AUDIO_OUTPUTS : activeMedia === "video" ? VIDEO_OUTPUTS : OTHER_FILE_OUTPUTS;
  const fileAccept =
    fileMedia === "other"
      ? ".pdf,.doc,.docx,.txt,.rtf,.odt,text/plain,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/rtf,application/vnd.oasis.opendocument.text"
      : "audio/*,video/*";

  useEffect(() => {
    setUrlForm((prev) => ({
      ...prev,
      outputFormat: isOutputCompatible(prev.outputFormat, urlMedia) ? prev.outputFormat : outputFallback(urlMedia),
    }));
  }, [urlMedia]);

  useEffect(() => {
    setUploadForm((prev) => ({
      ...prev,
      outputFormat: isOutputCompatible(prev.outputFormat, fileMedia) ? prev.outputFormat : outputFallback(fileMedia),
    }));
  }, [fileMedia]);

  async function refreshJobs() {
    const response = await fetch("/api/jobs", { cache: "no-store" });
    if (!response.ok) return;
    const payload = (await response.json()) as { jobs: SerializedJob[] };
    setJobs(payload.jobs);
  }

  useEffect(() => {
    const timer = setInterval(() => {
      refreshJobs().catch(() => undefined);
    }, 5000);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 2800);
    return () => clearTimeout(timer);
  }, [message]);

  function pickFile(file: File | null) {
    setSelectedFile(file);
  }

  function onFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    pickFile(event.target.files?.[0] ?? null);
  }

  function onDragOver(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setIsDragActive(true);
  }

  function onDragLeave(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setIsDragActive(false);
  }

  function onDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setIsDragActive(false);
    const file = event.dataTransfer.files?.[0] ?? null;
    pickFile(file);
  }

  async function submitUrl(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setError(null);
    setLoadingUrl(true);

    try {
      const response = await fetch("/api/jobs/url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...urlForm,
          outputFormat: isOutputCompatible(urlForm.outputFormat, urlMedia)
            ? urlForm.outputFormat
            : outputFallback(urlMedia),
          captchaToken: captchaEnabled ? urlForm.captchaToken : undefined,
        }),
      });

      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? "Submit URL failed");

      setMessage("Job added to queue.");
      setUrlForm((prev) => ({ ...prev, url: "", captchaToken: "" }));
      await refreshJobs();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingUrl(false);
    }
  }

  async function submitUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setError(null);
    setLoadingUpload(true);

    const form = event.currentTarget;
    const file = selectedFile;

    if (!file) {
      setError("Select a file");
      setLoadingUpload(false);
      return;
    }

    try {
      const outputFormat = isOutputCompatible(uploadForm.outputFormat, fileMedia)
        ? uploadForm.outputFormat
        : outputFallback(fileMedia);
      const inferredMime = (file.type && file.type.trim().length > 0
        ? file.type
        : inferMimeFromFilename(file.name)
      ).toLowerCase();
      const compatibility = isUploadConversionSupported(inferredMime, outputFormat);
      if (!compatibility.ok) {
        setError(compatibility.reason);
        setLoadingUpload(false);
        return;
      }

      const data = new FormData();
      data.set("file", file);
      data.set("outputFormat", outputFormat);
      data.set("audioQuality", uploadForm.audioQuality);
      data.set("videoQuality", uploadForm.videoQuality);

      const response = await fetch("/api/jobs/upload", {
        method: "POST",
        body: data,
      });

      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? "Upload failed");

      setMessage("Job added to queue.");
      form.reset();
      setSelectedFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      await refreshJobs();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingUpload(false);
    }
  }

  async function cancelJob(jobId: string) {
    setError(null);
    const response = await fetch(`/api/jobs/${jobId}/cancel`, { method: "POST" });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      setError(payload?.error ?? "Cancel failed");
      return;
    }
    await refreshJobs();
  }

  async function deleteJob(jobId: string) {
    setError(null);
    const response = await fetch(`/api/jobs/${jobId}`, { method: "DELETE" });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      setError(payload?.error ?? "Delete failed");
      return;
    }
    await refreshJobs();
  }

  async function logout() {
    setError(null);
    const response = await fetch("/api/auth/logout", { method: "POST" });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      setError(payload?.error ?? "Logout failed");
      return;
    }
    window.location.href = "/login";
  }

  return (
    <main className="container app-shell">
      {message ? (
        <div className="toast-layer" role="status" aria-live="polite" aria-atomic="true">
          <div className="toast toast-success">
            <svg className="toast-icon" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="10" fill="#4fd4aa" />
              <path d="M8 12.4L10.7 15L16 9.8" fill="none" stroke="#022217" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>{message}</span>
          </div>
        </div>
      ) : null}

      <header className="app-header panel">
        <div className="row app-header-top">
          <div className="app-brand-block">
            <h1 className="title app-title">Nexa</h1>
            <p className="small app-subtitle">Private hub for URL and file conversions.</p>
          </div>
          <div className="app-header-right">
            <p className="small app-meta-top">Device IP: {clientIp} · Active jobs: {activeCount}</p>
            {authRequired ? (
              <button type="button" className="secondary button-fixed" onClick={() => logout()}>
                Sign out
              </button>
            ) : null}
          </div>
        </div>

        <nav className={`source-menu segmented-control is-index-${sourceIndex}`} role="tablist" aria-label="Conversion source">
          <span className="segmented-indicator" aria-hidden />
          <button
            type="button"
            role="tab"
            aria-selected={activeSource === "url"}
            className={`source-tab ${activeSource === "url" ? "active" : ""}`}
            onClick={() => setActiveSource("url")}
          >
            From URL
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeSource === "file"}
            className={`source-tab ${activeSource === "file" ? "active" : ""}`}
            onClick={() => setActiveSource("file")}
          >
            From file
          </button>
        </nav>
      </header>

      <section className="panel section-spacing">
        <div className="converter-head">
          <h2 className="converter-title">{activeSource === "url" ? "URL conversion" : "File conversion"}</h2>

          <div
            className={`media-switch segmented-control is-count-${mediaCount} is-index-${mediaIndex} ${activeSource === "file" ? "file-mode" : ""}`}
            role="tablist"
            aria-label="Media type"
          >
            <span className="segmented-indicator" aria-hidden />
            <button
              type="button"
              role="tab"
              aria-selected={activeMedia === "audio"}
              className={`media-switch-tab ${activeMedia === "audio" ? "active" : ""}`}
              onClick={() => (activeSource === "url" ? setUrlMedia("audio") : setFileMedia("audio"))}
            >
              Audio
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeMedia === "video"}
              className={`media-switch-tab ${activeMedia === "video" ? "active" : ""}`}
              onClick={() => (activeSource === "url" ? setUrlMedia("video") : setFileMedia("video"))}
            >
              Video
            </button>
            {activeSource === "file" ? (
              <button
                type="button"
                role="tab"
                aria-selected={fileMedia === "other"}
                className={`media-switch-tab ${fileMedia === "other" ? "active" : ""}`}
                onClick={() => setFileMedia("other")}
              >
                Other files
              </button>
            ) : null}
          </div>
        </div>

        {activeSource === "url" ? (
          <div key={`url-${urlMedia}`} className="form-transition">
            <form className="grid" onSubmit={submitUrl}>
            <div className="grid field-stack">
              <label htmlFor="url">Source URL</label>
              <input
                id="url"
                type="text"
                value={urlForm.url}
                placeholder="https://..."
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                inputMode="url"
                onChange={(e) => setUrlForm((prev) => ({ ...prev, url: e.target.value }))}
                required
              />
              <div className="supported-services" aria-label="Supported services">
                <span className="supported-services-label">Supported services</span>
                <ul className="supported-services-list">
                  {SUPPORTED_URL_SERVICES.map((service) => (
                    <li key={service.id}>
                      <span className="service-chip">
                        <ServiceIcon service={service.id} />
                        <span className="service-chip-label">{service.label}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="grid grid-2">
              <div className="grid field-stack">
                <label>Output format</label>
                <select value={urlForm.outputFormat} onChange={(e) => setUrlForm((prev) => ({ ...prev, outputFormat: e.target.value }))}>
                  {outputOptions.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </div>

              {urlMedia === "audio" ? (
                <div className="grid field-stack">
                  <label>Audio quality</label>
                  <select value={urlForm.audioQuality} onChange={(e) => setUrlForm((prev) => ({ ...prev, audioQuality: e.target.value }))}>
                    <option value="low">low</option>
                    <option value="standard">standard</option>
                    <option value="high">high</option>
                  </select>
                </div>
              ) : (
                <div className="grid field-stack">
                  <label>Video preset</label>
                  <select value={urlForm.videoQuality} onChange={(e) => setUrlForm((prev) => ({ ...prev, videoQuality: e.target.value }))}>
                    <option value="p720">720p</option>
                    <option value="p1080">1080p</option>
                  </select>
                </div>
              )}
            </div>

            {captchaEnabled ? (
              <div className="grid field-stack">
                <label>Captcha token</label>
                <input
                  type="text"
                  value={urlForm.captchaToken}
                  onChange={(e) => setUrlForm((prev) => ({ ...prev, captchaToken: e.target.value }))}
                  placeholder={captchaSiteKey ? `Token (${captchaSiteKey.slice(0, 8)}...)` : "Enter token"}
                  required
                />
              </div>
            ) : null}

              <button type="submit" disabled={loadingUrl}>
                {loadingUrl ? "Converting..." : "Convert"}
              </button>
            </form>
          </div>
        ) : (
          <div key={`file-${fileMedia}`} className="form-transition">
            <form className="grid" onSubmit={submitUpload}>
            <div className="grid field-stack">
              <label htmlFor="file-upload">Input file</label>
              <input
                id="file-upload"
                name="file"
                type="file"
                ref={fileInputRef}
                onChange={onFileInputChange}
                accept={fileAccept}
                className="hidden-input"
              />
              <button
                type="button"
                className={`dropzone ${isDragActive ? "active" : ""}`}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
              >
                <span className="dropzone-title">
                  {selectedFile ? selectedFile.name : "Drag and drop a file here or click to select"}
                </span>
                <span className="dropzone-subtitle">
                  {selectedFile ? "To add another file, drag it here or click to select." : "No file selected"}
                </span>
              </button>
            </div>

            <div className="grid grid-2">
              <div className="grid field-stack">
                <label>Output format</label>
                <select value={uploadForm.outputFormat} onChange={(e) => setUploadForm((prev) => ({ ...prev, outputFormat: e.target.value }))}>
                  {outputOptions.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </div>

              {fileMedia === "audio" ? (
                <div className="grid field-stack">
                  <label>Audio quality</label>
                  <select value={uploadForm.audioQuality} onChange={(e) => setUploadForm((prev) => ({ ...prev, audioQuality: e.target.value }))}>
                    <option value="low">low</option>
                    <option value="standard">standard</option>
                    <option value="high">high</option>
                  </select>
                </div>
              ) : fileMedia === "video" ? (
                <div className="grid field-stack">
                  <label>Video preset</label>
                  <select value={uploadForm.videoQuality} onChange={(e) => setUploadForm((prev) => ({ ...prev, videoQuality: e.target.value }))}>
                    <option value="p720">720p</option>
                    <option value="p1080">1080p</option>
                  </select>
                </div>
              ) : (
                <div className="grid field-stack">
                  <label>Mode</label>
                  <input value="Document and text conversion" disabled readOnly />
                </div>
              )}
            </div>

              <button type="submit" disabled={loadingUpload}>
                {loadingUpload ? "Converting..." : "Convert"}
              </button>
            </form>
          </div>
        )}
      </section>

      {error ? <p className="small feedback error">{error}</p> : null}

      <section className="panel">
        <div className="row jobs-header">
          <h2 className="converter-title">Job Queue</h2>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Source</th>
                <th>Output</th>
                <th>Status</th>
                <th>Created</th>
                <th>Error</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => {
                const canDownload = job.status === "done";
                const canCancel = job.status === "queued" || job.status === "processing";

                return (
                  <tr key={job.id} className="job-row">
                    <td>{job.id.slice(0, 10)}...</td>
                    <td>
                      <div>{job.sourceType}</div>
                      {job.sourceUrl ? <div className="small url-preview">{job.sourceUrl}</div> : null}
                    </td>
                    <td>{job.outputFormat}</td>
                    <td><span className={`badge ${job.status}`}>{statusLabel(job)}</span></td>
                    <td>{new Date(job.createdAt).toLocaleString()}</td>
                    <td className="small">{job.errorMessage ?? "-"}</td>
                    <td>
                      <div className="row action-row">
                        {canDownload ? (
                          <a href={`/api/jobs/${job.id}/download`} className="action-link">
                            <button type="button" className="secondary button-fixed">Download</button>
                          </a>
                        ) : null}
                        {canCancel ? (
                          <button type="button" className="secondary button-fixed" onClick={() => cancelJob(job.id)}>Cancel</button>
                        ) : null}
                        <button type="button" className="danger button-fixed" onClick={() => deleteJob(job.id)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {jobs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="small">No jobs.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <footer className="small app-footer">Files are automatically deleted after 24 hours.</footer>
    </main>
  );
}
