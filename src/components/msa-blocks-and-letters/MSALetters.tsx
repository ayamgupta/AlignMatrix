/**
 * Hooks for pure webgl alignment details.
 */
import React, { useMemo } from "react";
import {
  AminoAcidAlignmentTypeInstance,
  AminoacidColorSchemeInstance,
  NucleotideAlignmentTypeInstance,
  NucleotideColorSchemeInstance,
  PositionsToStyleInstance,
  ResidueColoringInstance,
} from "../../common/MolecularStyles";
import { Alignment } from "../../common/Alignment";
import { MONO_FONT_FAMILY } from "../../common/FontUtils";

/**
 * Hook to render the alignment details text. Generates a div for each
 * color rendered, each of which contain all the visible
 * sequences (sequencesToRender) -- those letters which are not
 * stylized will be put as spaces.
 * @param props
 */
export function MSALetters(props: {
  allCharactersInAlignment: string[];

  sequencesInViewport: string[];
  slicedSequences: string[];
  consensusSequence: string;
  querySequence: string;

  alignmentType: AminoAcidAlignmentTypeInstance | NucleotideAlignmentTypeInstance;
  aaColorScheme?: AminoacidColorSchemeInstance;
  ntColorScheme?: NucleotideColorSchemeInstance;
  positionsToStyle: PositionsToStyleInstance;
  residueColoring: ResidueColoringInstance;

  fontSize: number;
  lineHeight: number;
  verticalOffset?: number;
  horizontalOffset?: number;
  horizontalWorldOffset?: number;
}) {
  const {
    allCharactersInAlignment,
    sequencesInViewport,
    slicedSequences,
    consensusSequence,
    querySequence,

    alignmentType,
    aaColorScheme,
    ntColorScheme,
    positionsToStyle,
    residueColoring,

    fontSize,
    lineHeight,
    verticalOffset,
    horizontalOffset,
    horizontalWorldOffset
  } = props;

  //each sequence style will be rendered as a single separate div.
  //munge the data first. letterColorToLocations contains:
  //  { 
  //    key = letter color as hex string: 
  //    value = [
  //        ordered array with each element representing a single sequence
  //        that contains an arrya of positions in that sequence with the
  //        given color
  //    ]
  //  }
  //with each letter color as key and each value is an array of
  //with each entry 
  const letterColorToLocations = useMemo(()=>{
    // Filter out empty sequences (placeholders for async-loading rows) so that
    // getPositionalLetterColors always receives at least one non-empty sequence
    // and uses a consistent sequence length. Without this, sequences[0].length
    // could be 0 while other sequences are full-length, causing msaColors[posIdx]
    // to be undefined and crashing on scroll.
    const nonEmptySlices = slicedSequences.filter(s => s.length > 0);

    const msaColors = Alignment.getPositionalLetterColors({
      allPossibleChars: allCharactersInAlignment,
      sequences: nonEmptySlices,
      querySequence: querySequence,
      consensusSequence: consensusSequence,
      alignmentType: alignmentType,
      positionsToStyle: positionsToStyle,
      residueColoring: residueColoring,
      aaColorScheme: aaColorScheme,
      ntColorScheme: ntColorScheme,
    });

    const toReturn = {} as {
      [letterColor: string]: { 
        [seqIdx: number]: number[] 
    }};

    // Use the expected sequence length from msaColors to guard against mismatches.
    // msaColors is indexed by posIdx; we need to know the valid range.
    const numPositions = nonEmptySlices.length > 0 ? nonEmptySlices[0].length : 0;

    for(
      let seqIdx = 0, lenSeqs = slicedSequences.length;
      seqIdx < lenSeqs;
      seqIdx++
    ){
      const seq = slicedSequences[seqIdx];
      // Skip empty placeholder sequences (async rows not yet loaded)
      if (!seq || seq.length === 0) { continue; }
      for(      
        let posIdx = 0, numPos = seq.length;
        posIdx < numPos;
        posIdx++
      ){
        // Guard: posIdx must be within the range msaColors was built for
        if (posIdx >= numPositions || !msaColors[posIdx]) { continue; }
        const letter = seq[posIdx];
        const letterColorAtPos = msaColors[posIdx][letter];
        // Guard: letter may not be in allCharactersInAlignment during async transitions
        if (!letterColorAtPos) { continue; }
        if(!toReturn[letterColorAtPos.letterColor.hexString]){
          toReturn[letterColorAtPos.letterColor.hexString] = {};
        }
        if(!toReturn[letterColorAtPos.letterColor.hexString][seqIdx]){
          toReturn[letterColorAtPos.letterColor.hexString][seqIdx] = [];
        }
        toReturn[letterColorAtPos.letterColor.hexString][seqIdx].push(posIdx)
      }
    }
    return toReturn;
  }, [
    allCharactersInAlignment,
    slicedSequences, //changes too frequently. what is that about?
    alignmentType,
    aaColorScheme, 
    ntColorScheme, 
    positionsToStyle,
    residueColoring,
    consensusSequence, 
    querySequence
  ]);
  
  //Array of JSX elements - one for each letter color. Each contains
  //a character for every position in the rendered sequences, (each
  //position will be blank for all except one of the elemnets)
  const individualColors = useMemo(()=>{
    return Object.entries(letterColorToLocations).map(
      ([color, locations]) => {
        const colorStrings = slicedSequences.map((seqStr, seqIdx) => {
          return seqStr
            .split("")
            .map((letter, colIdx) => {
              if (seqIdx in locations && locations[seqIdx].indexOf(colIdx) >= 0) {
                return letter;
              }
              return "\u00A0";
            })
            .join("");
        });

        return (
          <div
            className={`letters-with-specific-color`}
            style={{ color: color }}
            key={`${color}_${colorStrings.join("")}`}
          >
            {colorStrings.map((seqStr, idx) => {
              return (
                <React.Fragment key={idx + seqStr}>
                  {seqStr}
                  <br />
                </React.Fragment>
              );
            })}
          </div>
        );
      }
    );
  }, [
    letterColorToLocations, 
    slicedSequences
  ]);

  return (
    <>
      <div
        className="av2-letters sequence-text-holder"
        style={{
          top: verticalOffset,
          left: horizontalOffset,
          fontFamily: MONO_FONT_FAMILY
        }}
      >
        <div
          className="letters-viewport"
          style={{ 
            fontSize: fontSize, 
            lineHeight: lineHeight + "px" 
          }}
        >
          {
            //output each color separately
          }
          {individualColors}
        </div>
      </div>

      {
        // add a hidden interaction element that contains all the displayed sequences
        // so users can copy paste
      }
      <div 
        className={"hidden-residues-for-copy-paste"} 
        style={{ 
          top: verticalOffset,
          left: horizontalWorldOffset 
            ? -1 * horizontalWorldOffset
            : undefined,
          fontSize: fontSize, 
          fontFamily: MONO_FONT_FAMILY,
          lineHeight: lineHeight + "px"
        }}>
        {sequencesInViewport.map((seqStr, idx) => {
          return (
            <React.Fragment key={idx + seqStr}>
              {seqStr} <br />
            </React.Fragment>
          );
        })}
      </div>
    </>
  );
}
