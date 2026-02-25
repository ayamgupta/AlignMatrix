import { Alignment, ISequence } from "./Alignment";
import { getParseError } from "./Utils";
import { parseSequenceAnnotations } from './Annotations'

/**
 * FastaAlignment
 * This class represents a Fasta formatted multiple sequence alignment.
 */
export class FastaAlignment extends Alignment {
  /**
   * Parse a string that contains a fasta alignment.
   * @param fileName
   * @param fileContents
   */
  static fromFileContents(
    fileName: string,
    fileContents: string,
    removeDuplicateSequences?: boolean
  ): FastaAlignment {
    const trimmedFile = fileContents.trim();
    if (trimmedFile.length < 1 || trimmedFile[0] !== ">") {
      throw getParseError("Fasta", "File needs to begin with '>'");
    }

    const fastaSplitCaret = trimmedFile.split(">");
    var sequences: ISequence[] = [];
    for (var i = 0; i < fastaSplitCaret.length; i++) {
      const seqArr = fastaSplitCaret[i].split(/\r?\n/);
      if (seqArr.length > 1) {
        const idDesc = seqArr[0].match(/^\s*(?<id>\S+)(?:\s+(?<description>.+\S+)\s*)?$/)?.groups;
        const sequence = seqArr.slice(1).join("");
        if (idDesc) {
          sequences.push({
            sequence,
            annotations: parseSequenceAnnotations(idDesc.id, sequence, idDesc.description),
          });
        }
      }
    }
    try {
      return new FastaAlignment({
        name: fileName,
        sequencesAsInput: sequences,
        removeDuplicateSequences: removeDuplicateSequences
      });
    } catch (e) {
      throw getParseError("Fasta", (e as Error).message);
    }
  }

  /**
   * Parse a FASTA alignment from an async line iterator (streaming, low-memory).
   * This avoids loading the entire file as a string, making it suitable for
   * very large files (>500 MB).
   *
   * @param fileName
   * @param lineIterator  An AsyncIterable that yields one line at a time
   * @param removeDuplicateSequences
   */
  static async fromLineIterator(
    fileName: string,
    lineIterator: AsyncIterable<string>,
    removeDuplicateSequences?: boolean
  ): Promise<FastaAlignment> {
    const sequences: ISequence[] = [];
    let currentHeader: string | null = null;
    let currentSeqParts: string[] = [];
    let sawFirstContentLine = false;

    const flushCurrent = () => {
      if (currentHeader === null) return;
      const idDesc = currentHeader
        .match(/^\s*(?<id>\S+)(?:\s+(?<description>.+\S+)\s*)?$/)
        ?.groups;
      if (idDesc) {
        const sequence = currentSeqParts.join("");
        sequences.push({
          sequence,
          annotations: parseSequenceAnnotations(idDesc.id, sequence, idDesc.description),
        });
      }
      currentSeqParts = [];
    };

    try {
      for await (const rawLine of lineIterator) {
        const line = rawLine.replace(/\r$/, ""); // strip CR from CRLF
        if (line.startsWith(">")) {
          sawFirstContentLine = true;
          flushCurrent();
          currentHeader = line.slice(1); // everything after ">"
        } else if (currentHeader !== null) {
          // sequence data line
          const trimmed = line.trim();
          if (trimmed.length > 0) {
            currentSeqParts.push(trimmed);
          }
        } else if (!sawFirstContentLine && line.trim().length > 0) {
          // First non-empty content line doesn't start with ">" -> not FASTA
          throw getParseError("Fasta", "File needs to begin with '>'");
        }
      }
      flushCurrent();
    } catch (e) {
      if ((e as Error).name === "Fasta Parse Error") throw e;
      throw getParseError("Fasta", (e as Error).message);
    }

    if (sequences.length === 0) {
      throw getParseError("Fasta", "No sequences found in file");
    }

    try {
      return new FastaAlignment({
        name: fileName,
        sequencesAsInput: sequences,
        removeDuplicateSequences,
      });
    } catch (e) {
      throw getParseError("Fasta", (e as Error).message);
    }
  }
}
