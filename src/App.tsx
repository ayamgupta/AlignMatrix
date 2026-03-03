import React, { useCallback, useEffect, useMemo, useState } from "react";
import "./App.scss";
import { downloadFullViewportSVG } from "./common/FileExporter"
import { AlignmentViewer, IBarplotExposedProps } from "./components/AlignmentViewerHook";
import { shallowEqual } from "react-redux";
import useAV2Settings from "./components/settings/Settings";
import { AlignmentLoader } from "./common/AlignmentLoader";

export default function App(){
  const triggerShowSearch = React.useRef<() => void | undefined>();

  //local state
  const [state, setState] = useState(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const hasExplicitAlignment = urlParams.has("resultsPath") || urlParams.has("alignment-url");
    const isAutoLoading = true; // Always attempt auto-loading if nothing else is specified
    
    return {
      showSettings: hasExplicitAlignment ? false : !isAutoLoading,
      mainViewportVisibleIdxs: undefined as undefined | {
        seqIdxStart: number, seqIdxEnd: number,
        posIdxStart: number, posIdxEnd: number
      }
    };
  });

  const {
    showSettings,
  } = state;

  const hideSettingsFn = useCallback(()=>{
    setState((prev) => ({
      ...prev,
      showSettings: false
    }));
  }, []);

  const settings = useAV2Settings({
    requestSettingsClose: hideSettingsFn,
    useUrlAndLocalstorage: true
  });

  const [sortProgress, setSortProgress] = useState<number | null>(null);

  useEffect(() => {
    if (settings.currentlySelectedProperties.sortBy?.key === "as-input") {
      setSortProgress(null);
    } else {
      setSortProgress(0);
    }
    const originalOnSortUpdate = AlignmentLoader.onSortUpdate;
    AlignmentLoader.onSortUpdate = (key: string, progress: number, complete: boolean) => {
      if (originalOnSortUpdate) originalOnSortUpdate(key, progress, complete);
      if (key === settings.currentlySelectedProperties.sortBy?.key) {
        const p = Math.round(progress * 100);
        setSortProgress(progress > 0 && p === 0 ? 1 : p);
      }
    };

    const originalOnDataRefreshed = AlignmentLoader.onDataRefreshed;
    AlignmentLoader.onDataRefreshed = () => {
      if (originalOnDataRefreshed) originalOnDataRefreshed();
      setSortProgress(null);
    };

    return () => {
      AlignmentLoader.onSortUpdate = originalOnSortUpdate;
      AlignmentLoader.onDataRefreshed = originalOnDataRefreshed;
    };
  }, [settings.currentlySelectedProperties.sortBy?.key]);

  const {
    alignment,
    alignmentLoading,
    loadingStatus,
    ntColorScheme,
    aaColorScheme,
    alignmentType,
    showLogo,
    logoType,
    positionsToStyle,
    residueColoring,
    showAnnotations,
    showMinimap,
    sortBy,
    zoomLevel,
    barplots,
    statsVersion
  } = settings.currentlySelectedProperties;

  //const colorScheme = alignmentType === AlignmentTypes.AMINOACID
  //  ? aaColorScheme : ntColorScheme;

  //
  // settings box and main app rendering
  //
  const logoSvgId = alignment ? `logo-${alignment.getUUID()}` : "logoplot";

  const barplotsProps: IBarplotExposedProps[] = useMemo(()=>{
    return !alignment ? [] : barplots.map((bp)=>{
      return {
        svgId: `${bp.key}-barplot-${alignment?.getUUID()}`,
        dataSeriesSet: [bp],
        heightPx: 75
      }
    });
  }, [
    alignment,
    barplots,
    statsVersion
  ]);

  const renderedAlignment = useMemo(()=>{
    return !alignment 
      ? undefined 
      : (
        <div className="app-content">
          <AlignmentViewer
            alignment={alignment}
            statsVersion={statsVersion}
            alignmentType={alignmentType}
            aaColorScheme={aaColorScheme}
            ntColorScheme={ntColorScheme}
            residueColoring={residueColoring}
            positionsToStyle={positionsToStyle}
            triggerShowSearch={triggerShowSearch}
            mainViewportVisibleChanged={(newIdxs)=>{
              if(!shallowEqual(state.mainViewportVisibleIdxs, newIdxs)){
                setState({
                  ...state,
                  mainViewportVisibleIdxs: newIdxs
                })
              }
            }}
            zoomLevel={zoomLevel}
            sortBy={sortBy}
            disableSearch={false}
            disableSearchKeyboardShortcut={false}
            showQuery={true}
            showConsensus={true}
            showMinimap={showMinimap}
            showAnnotations={showAnnotations}
            showLogo={showLogo}
            logoOptions={{
              svgId: logoSvgId,
              logoType: logoType
            }}
            barplots={barplotsProps}
          ></AlignmentViewer>
        </div>
      )
  }, [
    alignment,
    barplotsProps,
    logoType,
    positionsToStyle,
    residueColoring,
    logoSvgId,
    showMinimap,
    showAnnotations,
    showLogo,
    sortBy,
    state,
    aaColorScheme,
    ntColorScheme,
    alignmentType,
    zoomLevel,
    statsVersion
  ]);

  //
  // the full settings box
  //
  const renderedSettingsBox = useMemo(()=>{

    const alignmentDescription = alignment ? (
      <>
        <h3><strong>Alignment:</strong> {alignment.getName()}</h3>
        <h4>
          {`${alignment.getSequenceCount()} sequences (rows) and ${alignment.getSequenceLength()} positions (columns)`}
          {alignment.getNumberRemovedDuplicateSequences() > 0 ||
           alignment.getNumberDuplicateSequencesInAlignment() > 0 ? (
             <span className="duplicates-removed">
               {alignment.getNumberRemovedDuplicateSequences() > 0
                 ? `${"\u2605"} ${alignment.getNumberRemovedDuplicateSequences()} duplicate sequences removed`
                 : `${"\u2605"} contains ${alignment.getNumberDuplicateSequencesInAlignment()} duplicate sequences`}
             </span>
           ) : null}
           <span className={`streaming-status ${alignment.isStreamingComplete() ? "complete" : "streaming"}`}>
             {alignment.isStreamingComplete() ? "Complete" : "Loading..."}
           </span>
        </h4>
      </>
    ) : (
      <></>
    );

    //
    // settings
    //
    return (
      <>
        {settings.dropZoneElement}
        <div style={{display: (alignmentLoading || (alignment && !showSettings)) ? "none" : undefined}}>
          {settings.element}
        </div>

        <div className="app-header">
          <div className="settings-box">
            <form>
              <div className="settings-header">
                <h2>{`Alignment Viewer`}</h2>

                <div className="settings-alignment-description">
                  {alignmentDescription}
                </div>

                {sortProgress !== null && (
                  <div className="header-sort-progress">
                    Sorting... {sortProgress}%
                  </div>
                )}

                <button
                  className={`download button-link${!alignment ? " hide" : ""}`}
                  type="button"
                  title="Download Full Viewport"
                  onClick={()=>{
                    if (alignment){
                      downloadFullViewportSVG({
                        alignment: alignment,
                        sortBy: sortBy,
                        alignmentType: alignmentType, 
                        aaColorScheme: aaColorScheme,
                        ntColorScheme: ntColorScheme,
                        positionsToStyle: positionsToStyle, 
                        residueColoring: residueColoring, 
                        logoSvgId: logoSvgId,
                        barplots: barplotsProps.map(bp => {
                          return {
                            svgId: bp.svgId, 
                            title: bp.dataSeriesSet.map(ds=>ds.description).join("/")
                          };
                        }),
                        includePositionAxis: true,
                        includeMetadata: true,
                        startSeqIdx: state.mainViewportVisibleIdxs?.seqIdxStart, 
                        endSeqIdx: state.mainViewportVisibleIdxs?.seqIdxEnd,
                      });

                      //downloadLogoSVG({
                      //  svgId: logoSvgId,
                      //  alignment: alignment,
                      //  alignmentType: style.alignmentType,
                      //  colorScheme: style.selectedColorScheme,
                      //  positionsToStyle: positionsToStyle,
                      //  positionalAxis: {
                      //    numPos: alignment.getSequenceLength(),
                      //    posHeight: 10, posWidth: 7,
                      //    spaceBtwBarplotAndPositionalAxis: 5
                      //  }
                      //})

                      //downloadBarplotSVG({
                      //  alignment: alignment,
                      //  svgId: barplots[0].svgId,
                      //  positionalAxis: {
                      //    numPos: alignment.getSequenceLength(),
                      //    posHeight: 10, posWidth: 7,
                      //    spaceBtwBarplotAndPositionalAxis: 5
                      //  }
                      //})
                    }
                  }}
                >
                  <img
                    alt="Download Alignment" 
                    width="16"
                    height="16"
                    src={`./download.svg`}
                  />
                </button>
                
                <button
                  id="search-button"
                  className="search-button button-link"
                  type="button"
                  title="Show Search"
                  onClick={() => {
                    if(triggerShowSearch.current) triggerShowSearch.current();
                  }}
                >
                  <img
                    alt="Show Search"
                    width="16"
                    height="16"
                    src={`./search.svg`}
                  />
                </button>

                <button
                  id="settings-toggle-button"
                  className="button-link settings-toggle"
                  type="button"
                  style={{ paddingRight: 0 }}
                  title={showSettings ? "Hide Settings" : "Show Settings"}
                  onClick={()=>{
                    setState({
                      ...state,
                      showSettings: !showSettings,
                    });
                  }}
                >
                  <img
                    alt="Show Settings Box"
                    width="16"
                    height="16"
                    src={`./settings.svg`}
                  />
                </button>
              </div> 
            </form>
          </div>
        </div>
      </>
    );
  }, [
    alignment,
    alignmentType,
    barplotsProps,
    aaColorScheme,
    ntColorScheme,
    positionsToStyle, 
    residueColoring,
    logoSvgId,
    showSettings,
    settings.dropZoneElement,
    settings.element,
    sortBy,
    state,
  ]);
  
  return (
    <>
      { !alignmentLoading && renderedSettingsBox }
      <div className={`fullscreen-loading-indicator ${alignmentLoading || settings.currentlySelectedProperties.alignmentLoadError ? "" : "hidden"}`}>
        {settings.currentlySelectedProperties.alignmentLoadError ? (
          <div className="error-container">
            <h2 className="loading-title">Load Error</h2>
            <div className="loading-status-text error-message">
              {settings.currentlySelectedProperties.alignmentLoadError.message}
            </div>
            {settings.currentlySelectedProperties.alignmentLoadError.errors.map((err, i) => (
              <div key={i} className="loading-status-text error-detail">
                {err.message}
              </div>
            ))}
          </div>
        ) : (
          <>
            <h2 className="loading-title">Alignment Viewer</h2>
            <div className="modern-progress-container">
              <div className="modern-progress-bar" />
            </div>
            {loadingStatus && (
              <div className="loading-status-text">{loadingStatus}</div>
            )}
          </>
        )}
      </div>
      { !alignmentLoading && renderedAlignment }
    </>
  );
};