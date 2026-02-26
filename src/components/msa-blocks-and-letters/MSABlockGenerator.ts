import * as PIXI from "pixi.js";
import { 
  generateCanvases,
  ICanvasAlignmentTiledProps, 
  ITiledImages
} from "../../webworkers/MSAGenerationWorker";
import { WorkerFactory } from "../../webworkers/WebWorkerFactory";
import { Observable } from "../../common/Observable";


export interface ISharedObservableCommons{
  loaded: boolean;
  cachePropsKey?: string;
}
export interface IWebglStandaloneSharedObservable extends ISharedObservableCommons{
  datatype: "webgl",
  getMSABlocksWebglApp: () => PIXI.Application<HTMLCanvasElement>;
}
export interface IPairedWebglObservable extends ISharedObservableCommons{
  datatype: "synced-webgl",
  getMSABlocksWebglApp: () => PIXI.Application<HTMLCanvasElement>;
  getMinimapBlocksWebglApp: () => PIXI.Application<HTMLCanvasElement>;
}
export interface ICanvasStandaloneSharedObservable extends ISharedObservableCommons{
  datatype: "canvas",
  getCanvasImageData: () => ITiledImages;
}

export type ObservableDatatypeNames = "webgl" | "synced-webgl" | "canvas"; 
export type ObservableDatatype<T> = 
    T extends "webgl" ? IWebglStandaloneSharedObservable:
    T extends "synced-webgl" ? IPairedWebglObservable:
    T extends "canvas" ? ICanvasStandaloneSharedObservable:
    never;

interface IExposedBlockGeneratorFunctionsCommon{
  updateMSA: (props: ICanvasAlignmentTiledProps, propsKey: string) => void;
}
export interface IExposedStandaloneWebglFunctions extends IExposedBlockGeneratorFunctionsCommon{
  updateObserver: Observable<IWebglStandaloneSharedObservable>;
}
export interface IExposedPairedWebglFunctions extends IExposedBlockGeneratorFunctionsCommon{
  updateObserver: Observable<IPairedWebglObservable>;
}
export interface IExposedCanvasFunctions extends IExposedBlockGeneratorFunctionsCommon{
  updateObserver: Observable<ICanvasStandaloneSharedObservable>;
}

//
// PIXI DEFAULTS
//
//PIXI.settings.SCALE_MODE = PIXI.SCALE_MODES.NEAREST;
//PIXI.SCALE = PIXI.SCALE_MODES.NEAREST;
//PIXI.BaseTexture.defaultOptions.scaleMode = PIXI.SCALE_MODES.NEAREST;
//PIXI.Sprite.


//
//Create a webgl canvas
//
const createWebGlContext = () => {
  const app = new PIXI.Application<HTMLCanvasElement>({
    antialias: true,
    resolution: window.devicePixelRatio,
    autoDensity: true,
    backgroundAlpha: 0,
    view: document.createElement("canvas")
  });
  app.ticker.autoStart = false;
  app.ticker['stop']();
  return app;
}

/**
 * Shortcut to create all canvases for a single alignmentviewer component.
 * It creates two webgl contexts (main viewport and minimap) as well as a
 * two canvases (consensus and query sequences).
 * 
 * This should only be called ONCE per viewport. If it is called too many
 * times (followed by the "get" methods) then it will result in multiple 
 * webgl viewports - and browsers have a limited number (~8-16) after which
 * the browsers start to dispose of the contexts (yikes!).
 * 
 * @returns 
 */
const createViewerSet = () =>{
  return {
    primaryViewportApp: createMSABlockGenerator("webgl"),
    minimapApp: createMSABlockGenerator("webgl"),
    consensusApp: createMSABlockGenerator("canvas"),
    queryApp: createMSABlockGenerator("canvas"),
  }
}
let primaryViewer: undefined | ReturnType<typeof createViewerSet>;
let searchViewer: undefined | ReturnType<typeof createViewerSet>;
export function getCachedCanvasGenerators(whichViewer: "primary" | "search"){
  if(whichViewer === "primary"){
    if(!primaryViewer)  primaryViewer = createViewerSet();
    return primaryViewer;
  }
  if(!searchViewer)  searchViewer = createViewerSet();
  return searchViewer;
}

/**
 * Low level function to generate and subscribe to changes to alignment viewer 
 * block canvases. This can be used for standalone instances of the main viewer 
 * or minimap if desired. 
 * @param datatype 
 * @returns 
 */
export function createMSABlockGenerator<
  T extends ObservableDatatypeNames
>(datatype: T){

  const appsAndCavnases = {} as {
    webglApp1?: ReturnType<IPairedWebglObservable["getMSABlocksWebglApp"]>,
    webglApp2?: ReturnType<IPairedWebglObservable["getMinimapBlocksWebglApp"]>,
    canvasApp?: ReturnType<ICanvasStandaloneSharedObservable["getCanvasImageData"]>,
  }

  let cacheData = undefined as undefined | ITiledImages;
  let cachePropsKey = undefined as undefined | string;
  let jobBeingExecutedPropsKey = undefined as undefined | string;
  let nextJobProps: ICanvasAlignmentTiledProps | undefined = undefined;
  let nextJobPropsKey: string | undefined = undefined;

  let worker = new WorkerFactory(generateCanvases);
  const sharedObservable = datatype === "synced-webgl" 
    ? new Observable({
        datatype: "synced-webgl",
        loaded: false,
        getMSABlocksWebglApp: ()=>{ //lazy load
          if(!appsAndCavnases.webglApp1){
            appsAndCavnases.webglApp1 = createWebGlContext();
            if(cacheData) dataUpdated(cacheData, true); //possibly already set by webglApp2
          }
          return appsAndCavnases.webglApp1;
        },
        getMinimapBlocksWebglApp: () => { //lazy load
          if(!appsAndCavnases.webglApp2){
            appsAndCavnases.webglApp2 = createWebGlContext();
            if(cacheData) dataUpdated(cacheData, true); //possibly already set by webglApp1
          }
          return appsAndCavnases.webglApp2;
        },
      } as ObservableDatatype<T>)

    : datatype === "webgl"
      ? new Observable({
          datatype: "webgl",
          loaded: false,
          getMSABlocksWebglApp: ()=>{ 
            if(!appsAndCavnases.webglApp1){
              appsAndCavnases.webglApp1 = createWebGlContext();
            }
            return appsAndCavnases.webglApp1;
          },
        } as ObservableDatatype<T>)

      : datatype === "canvas"
        ? new Observable({
            datatype: "canvas",
            loaded: false,
            getCanvasImageData: ()=>{ //lazy load - only to be consistant with webgl
              return appsAndCavnases.canvasApp;
            },
          } as ObservableDatatype<T>)
        : undefined;

  if(!sharedObservable) throw Error(
    `Invalid datatype "${datatype}" provided to createMSABlockGenerator`
  );
  
  /***************************************************
   *  
   * Munge data from webworker and informer observers
   *  - Munge for webgl: reset view (remove children) and
   *    add all tiles as sprites to the view.
   *  - Munge for canvas: Copy the single Image into a
   *    
   * 
   * @param data 
   * @param updatingFromCache 
   */
  const dataUpdated = (
    data: ITiledImages, 
    updatingFromCache: boolean
  ) => {
    cacheData = data;
    if(!updatingFromCache){
      cachePropsKey = jobBeingExecutedPropsKey;
      jobBeingExecutedPropsKey = undefined;
    }

    if(
      datatype === "webgl" || datatype === "synced-webgl"
    ){
      function updateWebgl(app?: PIXI.Application<HTMLCanvasElement>){
        if(app){
          // Destroy old children and their textures to prevent WebGL memory leaks
          while(app.stage.children[0]) {
            const child = app.stage.children[0] as PIXI.DisplayObject;
            app.stage.removeChild(child);
            child.destroy({ children: true, texture: true, baseTexture: true });
          }

          app.stage.position.set(0, 0);
          app.stage.scale.set(1, 1);

          for(var idx=0; idx < data.tiles.length; idx++){
            const tile = data.tiles[idx];
            const texture = PIXI.Texture.from(
              tile.image, { scaleMode: PIXI.SCALE_MODES.NEAREST }
            );
            const sprite = new PIXI.Sprite(texture);
            sprite.interactiveChildren = false;
            sprite.x = tile.pixelX;
            sprite.y = tile.pixelY;
            sprite.scale = {x: 1, y: 1};
            sprite.roundPixels = false;
            sprite.cacheAsBitmap = true; //important
            app.stage.addChild(sprite);
          }
        }
      }

      updateWebgl(appsAndCavnases.webglApp1);
      updateWebgl(appsAndCavnases.webglApp2); //okay if standalone webgl - nothing happens if null
    }
    else{
      //deal with canvas
      appsAndCavnases.canvasApp = data;
    }
    sharedObservable.set({
      ...(sharedObservable.get() as ObservableDatatype<T>),
      loaded: true,
      cachePropsKey: cachePropsKey
    })
  }


  //handle web worker responses, placing the canvases into
  //the webgl context and trigger an observable event
  const dataUpdatedFromWebworker = (message: {data: ITiledImages}) => {
    dataUpdated(message.data, false);
    
    // Check if there's a queued job
    if (nextJobProps && nextJobPropsKey) {
      const props = nextJobProps;
      const key = nextJobPropsKey;
      nextJobProps = undefined;
      nextJobPropsKey = undefined;
      submitMSAUpdateRequest(props, key);
    }
  }

  /**
   * Kickoff a generate canvas web worker job. If the canvas is already
   * available it will return immediately with the resulting canvas message,
   * , otherwise 
   * @param props 
   * @returns 
   */
  const submitMSAUpdateRequest = (
    props: ICanvasAlignmentTiledProps,
    propsKey: string
  ) => {
    //was the canvas in cache generated with these props? (common)
    //inform callers to make sure everyone is up to date
    if(propsKey === cachePropsKey){
      dataUpdated(cacheData!, true); 
      return;
    }

    //is there already a canvas being generated with these props? (common)
    if(propsKey === jobBeingExecutedPropsKey) {
      return;
    }

    if(jobBeingExecutedPropsKey){
      // A job is already in flight. Queue this one as the "next" job.
      // We only ever keep the latest one to avoid a backlog.
      nextJobProps = props;
      nextJobPropsKey = propsKey;
      return;
    }

    jobBeingExecutedPropsKey = propsKey;
    worker.postMessage(props);
    return;
  }

  //listen for updated canvases
  worker.onmessage = dataUpdatedFromWebworker;

  //return a function to request new images as well as an observable 
  //to receive the updates whenever images are created.
  return {
    updateMSA: submitMSAUpdateRequest,
    updateObserver: sharedObservable
  };
}
