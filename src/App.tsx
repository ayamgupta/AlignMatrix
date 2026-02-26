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
    const isAutoLoading = urlParams.has("resultsPath") || 
                         urlParams.has("alignment-url") ||
                         (window.location.pathname === "/" && window.location.search === "");
    
    return {
      showSettings: !isAutoLoading,
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

  useMemo(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const resultsPath = urlParams.get("resultsPath");
    const isRootWithoutParams = window.location.pathname === "/" && window.location.search === "";
    
    if (resultsPath || isRootWithoutParams) {
      const baseUrl = `http://localhost:8000/alignment-file`;
      const fetchUrl = resultsPath ? `${baseUrl}?resultsPath=${encodeURIComponent(resultsPath)}` : baseUrl;
      let updated = false;

      // Ensure alignment-url matches resultsPath
      if (urlParams.get("alignment-url") !== fetchUrl) {
        urlParams.set("alignment-url", fetchUrl);
        updated = true;
      }

      // Ensure alignment-name is extracted and set
      try {
        const decoded = decodeURIComponent(resultsPath || "");
        const name = !decoded ? "alignment-file" : (() => {
          const lastSlash = Math.max(decoded.lastIndexOf("/"), decoded.lastIndexOf("\\"));
          return decoded.substring(lastSlash + 1).split("?")[0];
        })();
        if (name && urlParams.get("alignment-name") !== name) {
          urlParams.set("alignment-name", name);
          updated = true;
        }
      } catch (e) {
        // ignore errors
      }

      if (updated && resultsPath) {
        window.history.replaceState({}, '', `${window.location.pathname}?${urlParams.toString()}`);
      }
    }
  }, []);

  const settings = useAV2Settings({
    requestSettingsClose: hideSettingsFn,
    useUrlAndLocalstorage: true
  });

  const [sortProgress, setSortProgress] = useState<number | null>(null);

  useEffect(() => {
    const originalOnSortUpdate = AlignmentLoader.onSortUpdate;
    AlignmentLoader.onSortUpdate = (key: string, progress: number, complete: boolean) => {
      if (originalOnSortUpdate) originalOnSortUpdate(key, progress, complete);
      if (key === settings.currentlySelectedProperties.sortBy?.key) {
        if (complete) {
          setSortProgress(null);
        } else {
          setSortProgress(Math.round(progress * 100));
        }
      }
    };
    return () => {
      AlignmentLoader.onSortUpdate = originalOnSortUpdate;
    };
  }, [settings.currentlySelectedProperties.sortBy?.key]);

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get("resultsPath") || (window.location.pathname === "/" && window.location.search === "")) {
      // Auto-hide settings so it doesn't pop up over the loading screen
      setState((prev) => ({ ...prev, showSettings: false }));
    }
  }, []);

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
                    src={`${process.env.PUBLIC_URL}/download.svg`}
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
                    src={`${process.env.PUBLIC_URL}/search.svg`}
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
                    src={`${process.env.PUBLIC_URL}/settings.svg`}
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