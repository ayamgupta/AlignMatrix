/**
 * AlignmentLoader
 * ---------------
 * Loads alignments from files or URLs.
 *
 * Large-file strategy (new)
 * -------------------------
 * When loading from a File, parsing + statistics computation runs in
 * AlignmentParserWorker. Crucially, the Worker KEEPS the sequences array in
 * its own memory — it never sends all sequences to the main thread.
 *
 * The main thread receives only metadata (counts, stats, consensus, etc.) and
 * creates an Alignment via Alignment.fromWorkerMetadata(). Row data is fetched
 * on demand in slices via alignment.getSlice(start, end).
 *
 * This eliminates two previous OOM causes:
 *   1. postMessage cloning of the entire sequences array
 *   2. useMemo in AlignmentViewerHook creating a full string[] copy
 */
import { Alignment } from "../common/Alignment";
import { FastaAlignment } from "../common/FastaAlignment";
import { StockholmAlignment } from "../common/StockholmAlignment";

export class AlignmentLoadError extends Error {
    errors: { name: string; message: string }[];
    possibleResolution?: string;
    constructor(
        message: string,
        errors: { name: string; message: string }[],
        possibleResolution?: string,
    ) {
        super(message);
        this.errors = errors;
        this.possibleResolution = possibleResolution;
    }
}

// ---------------------------------------------------------------------------
// AlignmentLoader
// ---------------------------------------------------------------------------

export class AlignmentLoader {
    public static AlignmentFileTypes = [StockholmAlignment, FastaAlignment];

    /**
     * Optional progress callback. Called with human-readable status strings
     * while the worker parses a large file.
     */
    public static onProgress: ((message: string) => void) | undefined =
        undefined;

    /**
     * Called when background stats computation completes (positional counts,
     * consensus). The UI should re-render the logo/barplot widgets at this point.
     */
    public static onStatsReady: ((alignment: Alignment) => void) | undefined =
        undefined;

    /**
     * Called during a background sort operation to provide incremental results.
     */
    public static onSortUpdate:
        | ((sortKey: string, progress: number, complete: boolean) => void)
        | undefined = undefined;

    /**
     * Called when the UI has finished rendering/refreshing a data slice.
     */
    public static onDataRefreshed: (() => void) | undefined = undefined;

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    public static async loadAlignmentFromURL(
        url: string,
        removeDuplicateSequences: boolean,
        callback: (a: Alignment) => void,
        errorCallback: (e: AlignmentLoadError) => void,
        alignmentName?: string,
    ) {
        // Robust filename extraction
        let finalName = alignmentName;
        if (!finalName) {
            try {
                const parsedUrl = new URL(url, window.location.origin);
                let nameSource = url;

                if (parsedUrl.searchParams.has("resultsPath")) {
                    nameSource =
                        parsedUrl.searchParams.get("resultsPath") || url;
                }

                const decoded = decodeURIComponent(nameSource);
                const lastSlash = Math.max(
                    decoded.lastIndexOf("/"),
                    decoded.lastIndexOf("\\"),
                );
                finalName = decoded.substring(lastSlash + 1).split("?")[0];

                if (!finalName || finalName === "alignment-file") {
                    finalName = decoded.split("/").pop()?.split("?")[0];
                }
            } catch (e) {
                finalName = url
                    .substring(url.lastIndexOf("/") + 1)
                    .split("?")[0];
            }
        }

        // Start the worker path with the URL instead of waiting for a full blob
        AlignmentLoader._loadViaWorker(
            null,
            removeDuplicateSequences,
            callback,
            errorCallback,
            url,
            finalName,
        );
    }

    public static loadAlignmentFromFile(
        file: File,
        removeDuplicateSequences: boolean,
        callback: (a: Alignment) => void,
        errorCallback: (e: AlignmentLoadError) => void,
    ) {
        const workerSupported =
            typeof Worker !== "undefined" &&
            typeof ReadableStream !== "undefined" &&
            typeof TextDecoderStream !== "undefined";

        if (workerSupported) {
            AlignmentLoader._loadViaWorker(
                file,
                removeDuplicateSequences,
                callback,
                errorCallback,
            );
        } else {
            AlignmentLoader._loadViaFileReader(
                file,
                removeDuplicateSequences,
                callback,
                errorCallback,
            );
        }
    }

    public static loadAlignmentFromText(
        alignmentName: string,
        text: string,
        removeDuplicateSequences: boolean,
    ): Alignment {
        const err = new AlignmentLoadError("Alignment Format Error", []);
        for (const AlignmentType of AlignmentLoader.AlignmentFileTypes) {
            try {
                return AlignmentType.fromFileContents(
                    alignmentName,
                    text,
                    removeDuplicateSequences,
                );
            } catch (e) {
                err.errors.push(e as { name: string; message: string });
            }
        }
        throw err;
    }

    // -------------------------------------------------------------------------
    // Worker path
    // -------------------------------------------------------------------------

    private static _loadViaWorker(
        file: File | null,
        removeDuplicateSequences: boolean,
        callback: (a: Alignment) => void,
        errorCallback: (e: AlignmentLoadError) => void,
        url?: string,
        alignmentName?: string,
    ) {
        let worker: Worker;
        try {
            worker = new Worker(
                new URL(
                    "../webworkers/AlignmentParserWorker.ts",
                    import.meta.url,
                ),
            );
        } catch (e) {
            if (file) {
                console.warn(
                    "AlignmentLoader: Worker creation failed, falling back to FileReader.",
                    e,
                );
                AlignmentLoader._loadViaFileReader(
                    file,
                    removeDuplicateSequences,
                    callback,
                    errorCallback,
                );
            } else {
                errorCallback(
                    new AlignmentLoadError("Worker not supported", []),
                );
            }
            return;
        }

        // Pending slice requests: requestId → { resolve, reject }
        let nextRequestId = 0;
        let liveAlignment: Alignment | null = null;
        const pendingSlices = new Map<
            number,
            {
                resolve: (v: {
                    sequences: string[];
                    annotations: any[];
                }) => void;
                reject: (e: Error) => void;
            }
        >();

        worker.onmessage = (event) => {
            const msg = event.data as
                | { type: "progress"; message: string }
                | {
                      type: "sortUpdate";
                      sortKey: string;
                      progress: number;
                      complete: boolean;
                  }
                | { type: "done"; data: any }
                | { type: "stats"; data: any }
                | {
                      type: "slice";
                      requestId: number;
                      sequences: string[];
                      annotations: any[];
                  }
                | {
                      type: "error";
                      name: string;
                      message: string;
                      errors?: any[];
                      possibleResolution?: string;
                  };

            if (msg.type === "sortUpdate") {
                AlignmentLoader.onSortUpdate?.(
                    msg.sortKey,
                    msg.progress,
                    msg.complete,
                );
                return;
            }

            if (msg.type === "progress") {
                AlignmentLoader.onProgress?.(msg.message);
                return;
            }

            if (msg.type === "slice") {
                const pending = pendingSlices.get(msg.requestId);
                if (pending) {
                    pendingSlices.delete(msg.requestId);
                    pending.resolve({
                        sequences: msg.sequences,
                        annotations: msg.annotations,
                    });
                }
                return;
            }

            if (msg.type === "stats") {
                // Background stats are ready — update the alignment in place
                if (liveAlignment) {
                    liveAlignment.onStatsReady(msg.data);
                    AlignmentLoader.onStatsReady?.(liveAlignment);
                }
                return;
            }

            // "done" or "error" — parsing is complete
            if (msg.type === "done") {
                try {
                    const getSliceFn = (
                        start: number,
                        end: number,
                        sortKey?: string,
                    ) =>
                        new Promise<{
                            sequences: string[];
                            annotations: any[];
                        }>((resolve, reject) => {
                            const requestId = nextRequestId++;
                            pendingSlices.set(requestId, { resolve, reject });
                            worker.postMessage({
                                type: "getSlice",
                                start,
                                end,
                                requestId,
                                sortKey: sortKey ?? "as-input",
                            });
                        });

                    if (liveAlignment) {
                        // If we already have a live alignment (from partial loading), just update it
                        liveAlignment.onStatsReady(msg.data);
                        AlignmentLoader.onStatsReady?.(liveAlignment);
                    } else {
                        liveAlignment = Alignment.fromWorkerMetadata(
                            msg.data,
                            getSliceFn,
                        );
                        callback(liveAlignment);
                    }
                } catch (e) {
                    worker.terminate();
                    errorCallback(
                        new AlignmentLoadError(
                            "Failed to reconstruct alignment",
                            [
                                {
                                    name: (e as Error).name,
                                    message: (e as Error).message,
                                },
                            ],
                        ),
                    );
                }
                // NOTE: do NOT terminate — worker stays alive for slice requests + stats
            } else if (msg.type === "error") {
                // error
                worker.terminate();
                errorCallback(
                    new AlignmentLoadError(
                        msg.message,
                        msg.errors ?? [
                            { name: msg.name, message: msg.message },
                        ],
                        msg.possibleResolution,
                    ),
                );
            }
        };

        worker.onerror = (e) => {
            worker.terminate();
            errorCallback(
                new AlignmentLoadError(
                    "Worker error during alignment parsing",
                    [{ name: "WorkerError", message: e.message ?? String(e) }],
                ),
            );
        };

        worker.postMessage({
            type: "parse",
            file,
            url,
            alignmentName,
            removeDuplicateSequences,
        });
    }

    // -------------------------------------------------------------------------
    // FileReader fallback (old browsers)
    // -------------------------------------------------------------------------

    private static _loadViaFileReader(
        file: File,
        removeDuplicateSequences: boolean,
        callback: (a: Alignment) => void,
        errorCallback: (e: AlignmentLoadError) => void,
    ) {
        const reader = new FileReader();
        reader.onload = () => {
            try {
                callback(
                    AlignmentLoader.loadAlignmentFromText(
                        file.name,
                        reader.result as string,
                        removeDuplicateSequences,
                    ),
                );
            } catch (e) {
                errorCallback(e as AlignmentLoadError);
            }
        };
        reader.readAsText(file);
    }
}
