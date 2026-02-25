import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Provider } from "react-redux";
import { PositionalAxis } from "./PositionalAxisHook";
import {
  SequenceLogo,
  ISequenceLogoProps,
  LogoType,
} from "./SequenceLogoHook";

import { MiniMap } from "./minimap/MiniMapHook";
import { Alignment } from "../common/Alignment";
import { DEFAULT_ANNOTATION_FIELDS } from "../common/Annotations";
import { SequenceSorter, SequenceSorterInstance } from "../common/AlignmentSorter";
import { reduxStore } from "../redux/ReduxStore";
import {
  AlignmentTypes,
  AminoAcidAlignmentTypeInstance,
  AminoAcidColorSchemes,
  AminoacidColorSchemeInstance,
  NucleotideAlignmentTypeInstance,
  NucleotideColorSchemeInstance,
  NucleotideColorSchemes,
  PositionsToStyle,
  PositionsToStyleInstance,
  ResidueColoring,
  ResidueColoringInstance
} from "../common/MolecularStyles";
import { generateUUIDv4 } from "../common/Utils";
import { getAlignmentFontDetails } from "../common/FontUtils";
import { 
  IPositionalBarplotProps,
  PositionalBarplot, 
  PreconfiguredPositionalBarplots 
} from "./PositionalBarplotHook";
import { ScrollbarOptions } from "./virtualization/VirtualizationTypes";
import { 
  IControllerRole, 
  IResponderRole, 
  VirtualizationRole
} from "./virtualization/VirtualizationTypes";
import { 
  AlignmentViewerLayout, 
  IAdjustableHeight, 
  IAdjustableWidth, 
  IFixedHeight, 
  IFixedWidth, 
  IMetadataContentAndHeight
} from "./layout/AlignmentViewerLayoutHook";
import { ISearchMatchDetails, SequenceSearch } from "./search/SequenceSearchHook";
import { useListenForSearchKeypresses } from "./search/SearchKeysListenerHook";
import { MSABlocksAndLetters } from "./msa-blocks-and-letters/MSABlocksAndLetters";
import { getCachedCanvasGenerators } from "./msa-blocks-and-letters/MSABlockGenerator";
import { AlignmentSpreadsheet, IAlignmentSpreadsheetProps } from "./alignment-metadata/AlignmentSpreadsheetHook";


//
// TYPES / INTERFACES
//
export type IAlignmentViewerProps = {
  alignment: Alignment;
  alignmentType?: AminoAcidAlignmentTypeInstance | NucleotideAlignmentTypeInstance;
  highlightPositionalMatches?: ISearchMatchDetails;
  triggerShowSearch?: React.MutableRefObject<(() => void) | undefined>;
  mainViewportVisibleChanged?: (props: {
    seqIdxStart: number,
    seqIdxEnd: number,
    posIdxStart: number,
    posIdxEnd: number
  }) => void;
} & Partial<Readonly<typeof defaultProps>>;


export type IBarplotExposedProps = Pick<
  IPositionalBarplotProps,
  "svgId" | "dataSeriesSet" | "tooltipPlacement" //TODO remove height prop
>;


//
// DEFAULT PROPS
//
const defaultProps = {
  positionsToStyle: PositionsToStyle.ALL as PositionsToStyleInstance,
  residueColoring: ResidueColoring.LIGHT as ResidueColoringInstance,

  disableSearch: false,
  disableSearchKeyboardShortcut: false,
  canvasGenerators: getCachedCanvasGenerators("primary"),

  zoomLevel: 13 as number,
  sortBy: SequenceSorter.INPUT as SequenceSorterInstance,
  aaColorScheme: AminoAcidColorSchemes.list[0] as AminoacidColorSchemeInstance,
  ntColorScheme: NucleotideColorSchemes.list[0] as NucleotideColorSchemeInstance,

  showAnnotations: true as boolean,
  showConsensus: true as boolean,
  showLogo: true as boolean,
  showMinimap: false as boolean,
  showQuery: true as boolean,
  showRuler: true as boolean,

  metadataSizing: {
    type: "adjustable-width",
    startingWidth: 150,
    minWidth: 50,
    maxWidth: 600
  } as IAdjustableWidth | IFixedWidth,

  minimapSizing: {
    type: "adjustable-width",
    startingWidth: 100,
    minWidth: 75,
    maxWidth: 600
  } as IAdjustableWidth | IFixedWidth,

  barplotSizing: {
    //type: "fixed-height",
    //height: 75
    type: "adjustable-height", 
    startingHeight: 60,
    minHeight: 25, 
    maxHeight: 200
  } as IFixedHeight | IAdjustableHeight,

  logoSizing: {
    //type: "fixed-height",
    //height: 150
    type: "adjustable-height", 
    startingHeight: 100,
    minHeight: 50, 
    maxHeight: 300
  } as IFixedHeight | IAdjustableHeight,

  logoOptions: {
    logoType: LogoType.LETTERS
  } as Pick<
    ISequenceLogoProps, 
    "svgId" | "tooltipPlacement" | "logoType"
  >,

  //array of individual barplots. Each barplot can contain multiple
  //dataseries. Note that more than 2 dataseries in a single plot
  //is difficult to understand and more than 3 is pretty much impossible
  barplots: [
    {
      svgId: `shannon-entropy-plus-gaps-${generateUUIDv4()}`,
      dataSeriesSet: [
        PreconfiguredPositionalBarplots.ShannonEntropy,
        PreconfiguredPositionalBarplots.Gaps,
      ],
      tooltipPlacement: undefined
    },
  ] as IBarplotExposedProps[],
};


/**
 * Main react hook for generating the entire alignment viewer visualization.
 * @param props 
 * @returns 
 */
export function AlignmentViewer(props: IAlignmentViewerProps) {
  const {
    canvasGenerators,
    highlightPositionalMatches,

    alignment,
    aaColorScheme,
    ntColorScheme,
    barplots,
    logoOptions,

    disableSearch,
    disableSearchKeyboardShortcut,
    triggerShowSearch,

    mainViewportVisibleChanged,
    metadataSizing,
    minimapSizing,
    logoSizing,
    barplotSizing,
    positionsToStyle,
    residueColoring,
    showAnnotations,
    showConsensus,
    showLogo,
    showMinimap,
    showQuery,
    showRuler,
    zoomLevel,
  } = {
    ...defaultProps,
    ...props
  };
  
  const {
    alignmentType = alignment.getPredictedType()
  } = props;

  //error check color scheme and sort are congruant with passed alignment type
  //if not, reset.
  let {sortBy} = {
    ...defaultProps,
    ...props
  }
  if(
    (alignmentType === AlignmentTypes.AMINOACID && 
     !SequenceSorter.ALL_AMINO_ACID_SORTERS.includes(sortBy)) ||
    (alignmentType === AlignmentTypes.NUCLEOTIDE &&
     !SequenceSorter.ALL_NUCLEOTIDE_SORTERS.includes(sortBy))
  ){
    console.error(
      `Misconfiguration - invalid sortBy (${sortBy.description}) passed to AlignmentViewer for
       alignmentType "${alignmentType.description}". Setting to input sort order.`
    );
    sortBy = SequenceSorter.INPUT;
  }

  const fontSize = zoomLevel;
  const annotationFontSize = zoomLevel + 3;
  const monoFontSize = getAlignmentFontDetails(fontSize, true);
  const defaultFontSize = getAlignmentFontDetails(fontSize, false);

  const residueWidth = monoFontSize.width;
  const residueHeight = monoFontSize.height > defaultFontSize.height
    ? monoFontSize.height
    : defaultFontSize.height;
  const singleLineHeight = residueHeight;
  
  
  //
  // search - listen for key events
  //
  const [showSearch, setShowSearch] = useState<boolean>(false);
  const showSearchFn = useCallback(()=>{
    setShowSearch(true);
  }, [])
  useEffect(() => {
    if(triggerShowSearch){
      triggerShowSearch.current = showSearchFn;
    }
  }, [showSearchFn, triggerShowSearch]);

  useListenForSearchKeypresses({
    disableSearch: disableSearchKeyboardShortcut,
    searchDialogRequested: showSearchFn
  });

  //
  //virtualization 
  //

  //load virtualization states from redux - there are 4 virtualizations
  const alignmentUUID = alignment.getUUID();

  //primary x-axis virtualization - main viewport, logo, positional axis, logo, barplots
  const [
    xViewportResponderVirtualization,
    xViewportControllerVirtualization,
  ]: [IResponderRole, IControllerRole] = useMemo(()=>{
    const responder = {
      virtualizationId: `x_viewport_virtualization_${alignmentUUID}`,
      role: VirtualizationRole.Responder
    } as IResponderRole;

    return [responder, {
      ...responder,
      role: VirtualizationRole.Controller,
      cellCount: alignment.getSequenceLength(),
      cellSizePx: residueWidth
    } as IControllerRole]
  }, [alignment, alignmentUUID, residueWidth]);

  //primary y-axis virtualization - main viewport, logo, positional axis, logo, barplots
  const [
    yViewportResponderVirtualization,
    yViewportControllerVirtualization,
  ]: [IResponderRole, IControllerRole] = useMemo(()=>{
    const responder = {
      virtualizationId: `y_viewport_virtualization_${alignmentUUID}`,
      role: VirtualizationRole.Responder
    } as IResponderRole;

    return [responder, {
      ...responder,
      role: VirtualizationRole.Controller,
      cellCount: alignment.getSequenceCount(),
      cellSizePx: residueHeight
    } as IControllerRole]
  }, [alignment, alignmentUUID, residueHeight]);

  //
  // state
  //
  const [
    mouseHoveringHorizontalContent, 
    setMouseHoveringHorizontalContent
  ] = useState<boolean>(false);
  const [
    mouseHoveringVerticalContent, 
    setMouseHoveringVerticalContent
  ] = useState<boolean>(false);


  //hover events
  const handleMouseHoveringHoriz = useCallback(()=>{
    setMouseHoveringHorizontalContent(true); 
  }, []);
  const handleMouseStoppedHoveringHoriz = useCallback(()=>{
    setMouseHoveringHorizontalContent(false); 
  }, []);
  const handleMouseHoveringVert = useCallback(()=>{
    setMouseHoveringVerticalContent(true); 
  }, []);
  const handleMouseStoppedHoveringVert = useCallback(()=>{
    setMouseHoveringVerticalContent(false); 
  }, []);

  //
  // cache
  //
  // For large files (alignment.getSlice is defined), sequences are fetched
  // on demand in slices rather than loaded all at once. This prevents OOM
  // when displaying alignments with millions of rows.
  //
  const [sequences, setSequences] = useState<string[]>([]);
  const [sequenceAnnotations, setSequenceAnnotations] = useState<any[]>([]);
  // rowOffset: the absolute index of sequences[0] in the full alignment.
  // MSABlocksAndLetters receives this so it can convert absolute→relative indices.
  const [rowOffset, setRowOffset] = useState<number>(0);
  // False while background stats are still computing (large files only).
  // Logo and barplots are hidden until this flips true.
  const [statsReady, setStatsReady] = useState<boolean>(true);

  // Track the visible row range so we only re-fetch when it changes
  const [visibleRowRange, setVisibleRowRange] = useState<{ start: number; end: number } | null>(null);

  // Whenever the alignment changes, reset and load sequences
  useEffect(() => {
    if (!alignment.getSlice) {
      // Small/URL file: sequences are in memory, load synchronously
      const seqs = alignment
        .getSequences(sortBy ? sortBy : defaultProps.sortBy)
        .map((iseq) => iseq.sequence);
      const anns = alignment
        .getSequences(sortBy ? sortBy : defaultProps.sortBy)
        .map((iseq) => iseq.annotations);
      setSequences(seqs);
      setSequenceAnnotations(anns);
      setVisibleRowRange(null);
    } else {
      // Large file: eagerly fetch an initial window of rows so the viewer
      // has something to render before the first matrixRendered callback fires.
      setSequences([]);
      setSequenceAnnotations([]);
      const initialEnd = Math.min(200, alignment.getSequenceCount());
      alignment.getSlice(0, initialEnd, sortBy?.key).then(({ sequences: seqs, annotations: anns }) => {
        setSequences(seqs);
        setSequenceAnnotations(anns);
        setRowOffset(0);
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alignment, sortBy]);

  // Watch for background stats completion on large-file alignments.
  // positionalLetterCounts starts empty and gets populated by the worker's
  // "stats" message. Poll with a short interval until entries appear.
  useEffect(() => {
    if (!alignment.getSlice) return; // small files: stats always ready
    setStatsReady(false);
    const check = () => {
      // getPositionalLetterCounts returns the internal Map — check its size
      const plc = (alignment as any).positionalLetterCounts as Map<any,any>;
      if (plc && plc.size > 0) {
        setStatsReady(true);
      } else {
        statsCheckTimer.current = window.setTimeout(check, 500);
      }
    };
    statsCheckTimer.current = window.setTimeout(check, 500);
    return () => { if (statsCheckTimer.current) clearTimeout(statsCheckTimer.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alignment]);

  const statsCheckTimer = React.useRef<number | undefined>(undefined);

  // For large files: fetch the visible row slice when the viewport changes
  useEffect(() => {
    if (!alignment.getSlice || visibleRowRange === null) return;
    let cancelled = false;
    const sliceStart = Math.max(0, visibleRowRange.start - 50);
    const sliceEnd = Math.min(alignment.getSequenceCount(), visibleRowRange.end + 51);
    alignment.getSlice(sliceStart, sliceEnd, sortBy?.key).then(
      ({ sequences: seqs, annotations: anns }) => {
        if (!cancelled) {
          setSequences(seqs);
          setSequenceAnnotations(anns);
          setRowOffset(sliceStart);
        }
      }
    );
    return () => { cancelled = true; };
  }, [alignment, visibleRowRange, sortBy]);

  

  //
  // renders
  //

  //general event listeners
  const attachEventHorizListeners = useCallback((props: {
    content: React.JSX.Element, 
    horizContent?: boolean,
    vertContent?: boolean,
    className?: string
  })=>{
    return (
      <div className={props.className}
        onMouseEnter={()=>{
          if(props.horizContent) handleMouseHoveringHoriz();
          if(props.vertContent) handleMouseHoveringVert();
        }}
        onMouseLeave={()=>{
          if(props.horizContent) handleMouseStoppedHoveringHoriz();
          if(props.vertContent) handleMouseStoppedHoveringVert();
        }}>
        {props.content}
      </div>
    );
  }, [
    handleMouseHoveringHoriz,
    handleMouseHoveringVert,
    handleMouseStoppedHoveringHoriz,
    handleMouseStoppedHoveringVert
  ]);

  //logos
  const renderedSequenceLogo = useMemo(() => {
    if (!statsReady) return undefined;
    return attachEventHorizListeners({
      horizContent: true,
      content: (
        <SequenceLogo
          svgId={logoOptions.svgId}
          alignment={alignment}
          alignmentType={alignmentType}
          aaColorScheme={aaColorScheme}
          ntColorScheme={ntColorScheme}
          positionsToStyle={positionsToStyle}
          glyphWidth={residueWidth}
          logoType={logoOptions.logoType}
          tooltipPlacement={logoOptions.tooltipPlacement}
          horizontalVirtualization={xViewportResponderVirtualization}
        />
      )
    });
  }, [
    alignment,
    logoOptions,
    positionsToStyle,
    residueWidth,
    xViewportResponderVirtualization,
    alignmentType,
    aaColorScheme,
    ntColorScheme,
    attachEventHorizListeners,
    statsReady
  ]);

  //barplots
  const renderBarplot = useCallback((
    barplotProps: IBarplotExposedProps
  ) => {
    if (!statsReady) return undefined;
    return attachEventHorizListeners({
      horizContent: true,
      content: (
        <PositionalBarplot
          svgId={barplotProps.svgId}
          alignment={alignment}
          searchDetails={highlightPositionalMatches}
          tooltipPlacement={barplotProps.tooltipPlacement}
          dataSeriesSet={barplotProps.dataSeriesSet}
          positionWidth={residueWidth}
          horizontalVirtualization={xViewportResponderVirtualization}
        ></PositionalBarplot>
      )
    });
  }, [
    alignment,
    attachEventHorizListeners,
    highlightPositionalMatches,
    residueWidth, 
    xViewportResponderVirtualization,
    statsReady,
  ]);

  //positionaxis
  const renderedPositionAxis = useMemo(()=>{
    return attachEventHorizListeners({
      horizContent: true,
      className: "position-box",
      content: (
        <PositionalAxis
          alignmentUUID={alignment.getUUID()}
          horizVirtualization={xViewportResponderVirtualization}
          positions={[...Array(alignment.getSequenceLength()).keys()]}
          fontSize={fontSize}
          residueWidth={residueWidth}
        />
      ),
    })
  }, [
    attachEventHorizListeners, 
    alignment,
    fontSize, 
    residueWidth,
    xViewportResponderVirtualization
  ]);

  //helper as we use this for both query and consensus
  const renderSingleSequence = useCallback((
    sequenceType: "consensus" | "query"
  )=>{
    return attachEventHorizListeners({
      horizContent: true,
      content: (
        <MSABlocksAndLetters
          canvasGenerator={
            sequenceType === "consensus" 
              ? canvasGenerators.consensusApp
              : canvasGenerators.queryApp
          }
          sequenceSet={sequenceType}

          alignment={alignment}
          sortBy={sortBy}
          horizVirtualization={xViewportResponderVirtualization}
          vertVirtualization={"None"}
          highlightPositionalMatches={highlightPositionalMatches}
          alignmentType={alignmentType}
          aaColorScheme={aaColorScheme}
          ntColorScheme={ntColorScheme}
          positionsToStyle={positionsToStyle}
          residueColoring={residueColoring}
          fontSize={fontSize}
          residueHeight={residueHeight}
          residueWidth={residueWidth}
          horizontalScrollbar={ScrollbarOptions.NeverOn}
        />
      )
    });
  }, [
    alignment,
    attachEventHorizListeners,
    canvasGenerators.consensusApp,
    canvasGenerators.queryApp,
    sortBy,
    fontSize, 
    highlightPositionalMatches,
    positionsToStyle,
    residueColoring,
    residueHeight,
    residueWidth,
    alignmentType,
    aaColorScheme,
    ntColorScheme,
    xViewportResponderVirtualization
  ]);

  //consensus
  const renderedConsensusSeq: IMetadataContentAndHeight | undefined = useMemo(()=>{
    return !showConsensus ? undefined : {
      metadata: "Consensus",
      content: renderSingleSequence("consensus"),
      heightPx: singleLineHeight
    };
  }, [
    renderSingleSequence,
    showConsensus,
    singleLineHeight
  ]);

  //query
  const renderedQuerySeq: IMetadataContentAndHeight | undefined = useMemo(()=>{
    return !showQuery ? undefined : {
      metadata: "Query",
      content: renderSingleSequence("query"),
      heightPx: singleLineHeight
    }
  }, [
    renderSingleSequence,
    showQuery,
    singleLineHeight
  ]);

  //minimap
  const renderedMinimap = useMemo(()=>{
    return ( !showMinimap ? undefined :
      <MiniMap
        canvasGenerator={canvasGenerators.minimapApp}
        alignment={alignment}
        alignmentType={alignmentType}
        aaColorScheme={aaColorScheme}
        ntColorScheme={ntColorScheme}
        positionsToStyle={positionsToStyle}
        highlightPositionalMatches={highlightPositionalMatches}
        sortBy={sortBy}
        externalSequences={alignment.getSlice ? sequences : undefined}
        syncWithVerticalVirtualization={
          yViewportResponderVirtualization
        }
      />
    );
  }, [
    alignment, 
    canvasGenerators.minimapApp,
    highlightPositionalMatches,
    alignmentType,
    aaColorScheme,
    ntColorScheme,
    positionsToStyle,
    showMinimap,
    sortBy,
    yViewportResponderVirtualization
  ]);

  const closeSearch = useCallback(()=>{
    setShowSearch(false);
  }, []);

  //dummy data
  const spreadsheetData = useMemo(()=>{
    const seqCount = alignment.getSequenceCount();
    const toreturn: IAlignmentSpreadsheetProps["columns"] = {
      "rownum": {
        key: "rownum",
        initialColumnName: "",
        initiallyPinned: true,
        rawData: Array.from({length: seqCount}, (_, idx) => idx + 1),
      },
    }

    const annotationFields = alignment.getAnnotationFields();

    if (!alignment.getSlice) {
      // Small/URL file: all annotations in memory
      const anns = alignment.getSequences(sortBy).map(s => s.annotations);
      for (const key of Object.keys(annotationFields)) {
        toreturn[key] = {
          key,
          initialColumnName: annotationFields[key].name,
          initiallyPinned: (key === DEFAULT_ANNOTATION_FIELDS.ID),
          rawData: anns.map(a => a?.[key] ?? ""),
        };
      }
    } else {
      // Large file: use a Proxy so the spreadsheet can index any row
      // but only rows in the current slice have real data; others show "".
      // The Proxy has a .length property so rawData.slice(0,100) in the
      // column-width measurement code still works.
      for (const key of Object.keys(annotationFields)) {
        const offset = rowOffset;
        const slice = sequenceAnnotations;
        const proxy = new Proxy([] as any[], {
          get(_, prop) {
            if (prop === "length") return seqCount;
            if (prop === "slice") {
              // Support array.slice(start, end) for column width measuring
              return (start: number, end: number) => {
                const result: any[] = [];
                for (let i = start; i < Math.min(end, seqCount); i++) {
                  const rel = i - offset;
                  result.push(rel >= 0 && rel < slice.length ? (slice[rel]?.[key] ?? "") : "");
                }
                return result;
              };
            }
            const idx = typeof prop === "string" ? parseInt(prop) : NaN;
            if (!isNaN(idx)) {
              const rel = idx - offset;
              return rel >= 0 && rel < slice.length ? (slice[rel]?.[key] ?? "") : "";
            }
            return undefined;
          }
        });
        toreturn[key] = {
          key,
          initialColumnName: annotationFields[key].name,
          initiallyPinned: (key === DEFAULT_ANNOTATION_FIELDS.ID),
          rawData: proxy,
        };
      }
    }

    return toreturn;
  }, [alignment, sortBy, sequenceAnnotations, rowOffset]);


  //
  // final render
  //
  return (
    <Provider store={reduxStore}>
      {!alignment || disableSearch ? undefined : 
        <div style={{display: !showSearch ? "none" : undefined}}>
          <SequenceSearch
            searchVisible={showSearch}
            closePressed={closeSearch}
            mainAlignmentQuerySequence={alignment.getQuery()}
            sortedSequences={sequences}
            sortedSequenceAnnotations={sequenceAnnotations}
            alignmentType={alignmentType}
            aaColorScheme={aaColorScheme}
            ntColorScheme={ntColorScheme}
            residueColoring={residueColoring}
            positionsToStyle={positionsToStyle}
          />
        </div>
      }
      <AlignmentViewerLayout
        showMetadata={showAnnotations}
        showPositionalAxis={showRuler}
        showLogoPlot={showLogo}
        showQuery={showQuery}
        showConsensus={showConsensus}
        showMinimap={showMinimap}

        metadataSizing={metadataSizing}
        minimapSizing={minimapSizing}
        logoSizing={logoSizing}
        barplotSizing={barplotSizing}
        titleFontSize={annotationFontSize}

        alignmentDetails={{
          metadata: attachEventHorizListeners({
            vertContent: true,
            content: (
              <AlignmentSpreadsheet
                alignmentUUID={alignmentUUID}
                rowHeight={residueHeight}
                fontSize={fontSize}
                verticalVirtualization={{
                  virtualization: yViewportResponderVirtualization,
                  scrollbar: ScrollbarOptions.NeverOn
                }}
                columns={spreadsheetData}
              ></AlignmentSpreadsheet>
            )
          }),
          content: attachEventHorizListeners({
            horizContent: true,
            vertContent: true,
            content: (
              <MSABlocksAndLetters
                canvasGenerator={
                  canvasGenerators.primaryViewportApp
                }
                sequenceSet={"alignment"}
                alignment={alignment}
                sortBy={sortBy}
                externalSequences={alignment.getSlice ? sequences : undefined}
                externalSequencesOffset={alignment.getSlice ? rowOffset : 0}
                vertVirtualization={yViewportControllerVirtualization}
                horizVirtualization={xViewportControllerVirtualization}
                highlightPositionalMatches={highlightPositionalMatches}
                alignmentType={alignmentType}
                aaColorScheme={aaColorScheme}
                ntColorScheme={ntColorScheme}
                positionsToStyle={positionsToStyle}
                residueColoring={residueColoring}
                fontSize={fontSize}
                residueHeight={residueHeight}
                residueWidth={residueWidth}
                verticalScrollbar={
                  mouseHoveringVerticalContent
                    ? ScrollbarOptions.AlwaysOnWhenOverflowed
                    : ScrollbarOptions.OnHoverWhenOverflowed
                }
                horizontalScrollbar={
                  mouseHoveringHorizontalContent
                    ? ScrollbarOptions.AlwaysOnWhenOverflowed
                    : ScrollbarOptions.OnHoverWhenOverflowed
                }
                matrixRendered={(props)=>{
                  if (mainViewportVisibleChanged){
                    mainViewportVisibleChanged(props)
                  }
                  // Update visible row range for large-file slice fetching
                  if (alignment.getSlice) {
                    setVisibleRowRange({ start: props.seqIdxStart, end: props.seqIdxEnd });
                  }
                }}
              ></MSABlocksAndLetters>
            )
          })
        }}

        consensus={renderedConsensusSeq}

        query={renderedQuerySeq}

        positionalAxis={{
          metadata: "Position",
          content: renderedPositionAxis,
          heightPx: singleLineHeight
        }}

        barplots={!barplots || barplots.length < 1
          ? []
          : barplots.map((barplot) => {
            return {
              metadata: barplot.dataSeriesSet.map(
                (series) => series.description
              ).join(" / "),
              content: renderBarplot(barplot) ?? <div/>,
              contentKey: barplot.svgId
            }
          })
        }

        logoPlot={{
          metadata: "Logo",
          content: renderedSequenceLogo ?? <div/>
        }}

        minimapPlot={renderedMinimap}
      /> 
    </Provider>
  );
}
