/**
 * This class contains methods for sorting sequences
 */
import { IListOfPropObjects, IPropObjectInstanceInList } from "./GlobalEnumObject";
import { Alignment, ISequence } from "./Alignment";
import { BLOSUM62 } from "./BLOSUM";
import { DEFAULT_ANNOTATION_FIELDS } from "./Annotations";


export interface SequenceSorterInstance extends IPropObjectInstanceInList {
  targetAlignmentType: "aminoacid" | "nucleotide" | "both";
  sortFn: (
    sequencesAsInput: ISequence[],
    alignment: Alignment
  ) => ISequence[];
}

export const SequenceSorter = (() => {
  //
  //
  // HELPER
  //
  //
  function hammingDistance(seq1: ISequence, seq2: ISequence) {
    const s1 = seq1.sequence;
    const s2 = seq2.sequence;
    const minLength = Math.min(s1.length, s2.length);
    let distance = Math.abs(s1.length - s2.length);
    for (var i = 0; i < minLength; i++) {
      if (s1[i] !== s2[i]) {
        distance += 1;
      }
    }
    return distance;
  }

  function blosumScore(seq1: ISequence, seq2: ISequence) {
    const s1 = seq1.sequence;
    const s2 = seq2.sequence;
    const minLength = Math.min(s1.length, s2.length);
    let score = 0;
    for (var i = 0; i < minLength; i++) {
      const a = s1[i];
      const b = s2[i];
      if (
        BLOSUM62.has(a) &&
        BLOSUM62.get(a)!.has(b)
      ) {
        score += BLOSUM62.get(a)!.get(b)!;
      }
    }
    return score;
  }

  
  //
  //
  // AVAILBLE SORT TYPES WITH FUNCTIONS
  //
  //
  const propList = {

    INPUT: {
      key: "as-input",
      description: "As input",
      targetAlignmentType: "both",
      sortFn: (sequencesAsInput, alignment) => sequencesAsInput
     } satisfies SequenceSorterInstance,
    
    ID: {
      key: "id",
      description: "Sequence ID",
      targetAlignmentType: "both",
      sortFn: (sequences, alignment) => {
        return [...sequences].sort((a, b) => 
          a.annotations[DEFAULT_ANNOTATION_FIELDS.ID].localeCompare(b.annotations[DEFAULT_ANNOTATION_FIELDS.ID])
        );
      }
    } satisfies SequenceSorterInstance,

    GAPS: {
      key: "gaps",
      description: "Number of gaps",
      targetAlignmentType: "both",
      sortFn: (sequences, alignment) => {
        return [...sequences].sort((a, b) => 
          ((a.annotations[DEFAULT_ANNOTATION_FIELDS.INTERNAL_GAP_COUNT] as number) || 0) - 
          ((b.annotations[DEFAULT_ANNOTATION_FIELDS.INTERNAL_GAP_COUNT] as number) || 0)
        );
      }
    } satisfies SequenceSorterInstance,

    HAMMING_DIST_QUERY: {
      key: "hamming-dist-to-query",
      description: "Hamming distance to query sequence",
      targetAlignmentType: "both",
      sortFn: (sequences, alignment) => {
          const querySeq = alignment.getQuery();
          const distMap = new Map<ISequence, number>();
          for(const seq of sequences) {
            distMap.set(seq, hammingDistance(querySeq, seq));
          }
          return [...sequences]
            .sort((seq1, seq2) => {
              return distMap.get(seq1)! - distMap.get(seq2)!;
            });
        }
    } satisfies SequenceSorterInstance,
    
    HAMMING_DIST_CONSENSUS: {
      key: "hamming-dist-to-consensus",
      description: "Hamming distance to consensus sequence",
      targetAlignmentType: "both",
      sortFn: (sequences, alignment) => {
        const consensusSeq = alignment.getConsensus();
        const distMap = new Map<ISequence, number>();
        for(const seq of sequences) {
          distMap.set(seq, hammingDistance(consensusSeq, seq));
        }
        return [...sequences]
          .sort((seq1, seq2) => {
            return distMap.get(seq1)! - distMap.get(seq2)!;
          });
        }
    } satisfies SequenceSorterInstance,
    
    BLOSUM62_SCORE_QUERY: {
      key: "blosum-score-to-query",
      description: "BLOSUM62 score to query sequence",
      targetAlignmentType: "aminoacid",
      sortFn: (sequences, alignment) => {
        const querySeq = alignment.getQuery();
        const scoreMap = new Map<ISequence, number>();
        for(const seq of sequences) {
          scoreMap.set(seq, blosumScore(querySeq, seq));
        }
        return [...sequences]
          .sort((seq1, seq2) => {
            return scoreMap.get(seq2)! - scoreMap.get(seq1)!; //reverse from distance
          });
        }
    } satisfies SequenceSorterInstance,
    
    BLOSUM62_SCORE_CONSENSUS: {
      key: "blosum-score-to-consensus",
      description: "BLOSUM62 score to consensus sequence",
      targetAlignmentType: "aminoacid",
      sortFn: (sequences, alignment) => {
        const consensusSeq = alignment.getConsensus();
        const scoreMap = new Map<ISequence, number>();
        for(const seq of sequences) {
          scoreMap.set(seq, blosumScore(consensusSeq, seq));
        }
        return [...sequences]
          .sort((seq1, seq2) => {
            return scoreMap.get(seq2)! - scoreMap.get(seq1)!; //reverse from distance
          });
        }
    } satisfies SequenceSorterInstance,
  };
  
  // 
  // 
  // LIST OF ALL AVAILABLE OPTIONS
  // 
  // 
  const propListObj = IListOfPropObjects(Object.values(propList));

  const aminoAcidSorters = propListObj.list.filter(seqSort => 
    seqSort.targetAlignmentType === "aminoacid" || seqSort.targetAlignmentType === "both"
  );

  const nucleotideSorters = propListObj.list.filter(seqSort => 
    seqSort.targetAlignmentType === "nucleotide" || seqSort.targetAlignmentType === "both"
  );

  return {
    ALL_AMINO_ACID_SORTERS: aminoAcidSorters,
    ALL_NUCLEOTIDE_SORTERS: nucleotideSorters,
    ...propList,
    ...propListObj,
    list: propListObj.list
  };
})();
