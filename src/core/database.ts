import BoxTransaction from './transaction';
import BoxModelBuilder, { BoxModel, rangeBuilder } from './model';
import { TransactionTask, TransactionType } from './task';
import {
  BoxScheme,
  BoxDataTypes,
  BoxOption,
  BoxModelMeta,
  BoxIndexConfig,
  ConfiguredBoxScheme,
  BoxCursorDirections,
} from './types';
import { BoxDBError } from './errors';

export interface BoxModelOption {
  autoIncrement?: boolean;
  force?: boolean;
}

interface BoxMetaMap {
  [storeName: string]: BoxModelMeta;
}

type ListenerMap = {
  [key in BoxDBEvent]: BoxDBEventListener[];
};
export type BoxDBEvent = 'versionchange' | 'error' | 'abort' | 'close';
export type BoxDBEventListener = (event: Event) => void;

export type BoxDBType = typeof BoxDB;
class BoxDB {
  public static Types = BoxDataTypes;
  public static Order = BoxCursorDirections;
  public static Range = rangeBuilder;
  private idb: IDBDatabase = null;
  private ready = false;
  private name: string;
  private version: number;
  private metas: BoxMetaMap = {};
  private events: ListenerMap = {
    versionchange: [],
    error: [],
    abort: [],
    close: [],
  };
  private tx: BoxTransaction;
  private builder: BoxModelBuilder;

  /**
   * @constructor
   * @param databaseName idb name
   * @param version idb version
   */
  constructor(databaseName: string, version: number) {
    this.name = databaseName;
    this.version = version;
    this.tx = new BoxTransaction();
    this.builder = BoxModelBuilder.get(this.tx);
  }

  getDB(): IDBDatabase {
    return this.idb;
  }

  getName(): string {
    return this.name;
  }

  getVersion(): number {
    return this.version;
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * Returns interrupt transaction task
   */
  static interrupt(): TransactionTask {
    return new TransactionTask(TransactionType.INTERRUPT, null, null, null);
  }

  /**
   * Create/update object stores and open idb
   */
  open(): Promise<Event> {
    return new Promise((resolve, reject) => {
      const openRequest = self.indexedDB.open(this.name, this.version);
      const close = () => {
        openRequest.result && openRequest.result.close();
      };

      // IDB Open successfully
      openRequest.onsuccess = (event) => {
        this.ready = true;
        this.idb = openRequest.result;
        this.tx.init(openRequest.result);

        // IDB event listener
        for (const type in this.events) {
          this.idb.addEventListener(type, (event) => {
            this.events[type].forEach((f) => f(event));
          });
        }
        resolve(event);
      };

      openRequest.onupgradeneeded = () => {
        try {
          this.update(openRequest);
        } catch (e) {
          close();
          reject(e);
        }
      };

      openRequest.onblocked = () => {
        reject(new BoxDBError('Can not upgrade because the database is already opened'));
      };
      openRequest.onerror = (event) => {
        close();
        reject(event);
      };
    });
  }

  /**
   * Define box model
   *
   * @param storeName
   * @param scheme
   * @param options
   */
  model<S extends BoxScheme>(storeName: string, scheme: S, options?: BoxModelOption): BoxModel<S> {
    if (this.ready) {
      throw new BoxDBError('Cannot define model after database opened');
    }

    if (this.metas[storeName]) {
      throw new BoxDBError(storeName + ' model already defined');
    } else {
      this.metas[storeName] = this.toMeta(storeName, scheme, options);
    }

    return this.builder.build(this.version, storeName, scheme);
  }

  /**
   * Returns model names on this database
   *
   * @returns Registred model names (object store names)
   */
  modelNames(): string[] {
    return Object.keys(this.metas);
  }

  /**
   * Add idb global event listener
   *
   * @param type BoxDBEvent
   * @param listener
   */
  on(type: BoxDBEvent, listener: BoxDBEventListener): void {
    this.events[type].push(listener);
  }

  /**
   * Remove registed event listener
   *
   * @param type BoxDBEvent
   * @param listener
   */
  off(type: BoxDBEvent, listener: BoxDBEventListener): void {
    const listenerIdx = this.events[type].indexOf(listener);
    ~listenerIdx && this.events[type].splice(listenerIdx, 1);
  }

  /**
   * Tasks are performed as transactions
   *
   * @param tasks Transaction tasks
   */
  transaction(tasks: TransactionTask[]): Promise<void> {
    if (tasks.every((task) => task instanceof TransactionTask)) {
      return this.tx.runAll(tasks);
    } else {
      throw new BoxDBError('Invalid elements');
    }
  }

  /**
   * Close database connection
   */
  close(): void {
    if (this.ready) {
      this.tx.close();
      this.idb.close();
      this.ready = false;
    } else {
      throw new BoxDBError('Database not ready');
    }
  }

  /**
   * Create BoxModelMeta object
   *
   * @param name
   * @param scheme
   * @param keyPath
   * @param autoIncrement
   * @param index
   * @param force
   * @returns
   */
  private meta(
    name: string,
    scheme: ConfiguredBoxScheme,
    inKey: string,
    outKey: boolean,
    index: BoxIndexConfig[],
    force: boolean,
  ): BoxModelMeta {
    return { name, scheme, inKey, outKey, index, force };
  }

  /**
   * IDBObjectStore to BoxModelMeta
   *
   * @param objectStore target object store
   */
  private convert(objectStore: IDBObjectStore): BoxModelMeta {
    return this.meta(
      objectStore.name,
      null,
      Array.isArray(objectStore.keyPath) ? objectStore.keyPath[0] : objectStore.keyPath,
      objectStore.autoIncrement,
      Array.from(objectStore.indexNames).map((name) => {
        const idx = objectStore.index(name);
        return { keyPath: idx.keyPath, unique: idx.unique } as BoxIndexConfig;
      }),
      false,
    );
  }

  /**
   * Model scheme object to BoxModelMeta
   *
   * @param storeName object store name
   * @param scheme model scheme
   */
  private toMeta(storeName: string, scheme: BoxScheme, options?: BoxOption): BoxModelMeta {
    let primaryKeyPath = null;
    const indexList = [];

    const configuredScheme = Object.entries(scheme).reduce((prev, [field, type]) => {
      // Is BoxDataTypes
      if (typeof type === 'string') {
        prev[field] = { type };
      } else {
        // Is ConfiguredType
        // If this field use as keyPath(in-line key) for object store
        if (type.key) {
          // info: not available multiple in-line-key in bxd
          if (primaryKeyPath) {
            throw new BoxDBError('Cannot define mutiple in-line-key: ' + storeName);
          }

          // Set this field to in-line key
          primaryKeyPath = field;
        }

        if (type.unique && !type.index) {
          throw new BoxDBError('`unique` option requires index option');
        }

        // If this field configured for using index
        type.index && indexList.push({ keyPath: field, unique: Boolean(type.unique) });
        prev[field] = type;
      }

      return prev;
    }, {} as ConfiguredBoxScheme);

    return this.meta(
      storeName,
      configuredScheme,
      primaryKeyPath,
      Boolean(options?.autoIncrement),
      indexList,
      Boolean(options?.force),
    );
  }

  /**
   * Update defined object stores
   *
   * @param openRequest IDBOpenRequest
   * @param event Event from onupgradeneeded event
   */
  private update(openRequest: IDBOpenDBRequest) {
    const db = openRequest.result;
    const tx = openRequest.transaction;
    // Object store names in IDB
    const objectStoreNames = Array.from(db.objectStoreNames);
    // defined model(object store) names
    const modelStoreNames = Object.keys(this.metas);
    // Helper function that get metadata of defined model
    const getBoxMeta = (name: string) => this.metas[name];

    objectStoreNames.forEach((name, idx) => {
      // Update exist object store
      if (modelStoreNames.includes(name)) {
        const { inKey, outKey, index, force } = getBoxMeta(name);
        const objectStore = tx.objectStore(name);
        const objectStoreMeta = this.convert(objectStore);

        // Delete exist object store
        if (force) {
          db.deleteObjectStore(name);
          objectStoreNames.splice(idx, 1); // This object store will be created
          return;
        }

        if (objectStoreMeta.inKey !== inKey) {
          throw new BoxDBError('In-line-key cannot be changed: ' + name);
        }

        if (objectStoreMeta.outKey !== outKey) {
          throw new BoxDBError('Out-of-line-key cannot be changed: ' + name);
        }

        // Update indexes
        const getKeyPath = (indexConfig) => indexConfig.keyPath;
        const idbKeyPaths = objectStoreMeta.index.map(getKeyPath);
        const modelKeyPaths = index.map(getKeyPath);

        // (1/3) Update unique option of index
        objectStoreMeta.index.forEach((objectStoreIndex) => {
          const modelIndex = index.find(({ keyPath }) => keyPath === objectStoreIndex.keyPath);
          const originKeyPath = objectStoreIndex.keyPath;

          // Index option updated
          if (modelIndex && objectStoreIndex.unique !== modelIndex.unique) {
            // Change unique option true -> false is available
            if (objectStoreIndex.unique === true) {
              // Delete exist index and re-create
              objectStore.deleteIndex(originKeyPath);
              objectStore.createIndex(originKeyPath, originKeyPath, {
                unique: modelIndex.unique,
              });
            } else {
              throw new BoxDBError('Unique option cannot be changed to true: ' + originKeyPath);
            }
          }
        });

        // (2/3) Delete index if index not found in scheme of target model
        idbKeyPaths.forEach((keyPath) => {
          !modelKeyPaths.includes(keyPath) && objectStore.deleteIndex(keyPath);
        });

        // (3/3) Create new index if index not exist in object store
        index.forEach(({ keyPath, unique }) => {
          !idbKeyPaths.includes(keyPath) && objectStore.createIndex(keyPath, keyPath, { unique });
        });
      } else {
        // Delete object store (model not defined)
        db.deleteObjectStore(name);
      }
    });

    // Create new object stores
    modelStoreNames
      .filter((name) => !objectStoreNames.includes(name))
      .forEach((name) => {
        const { inKey, outKey, index } = getBoxMeta(name);
        const objectStore = db.createObjectStore(name, {
          ...(inKey ? { keyPath: inKey } : null),
          autoIncrement: outKey,
        });

        index.forEach(({ keyPath, unique }) =>
          objectStore.createIndex(keyPath, keyPath, { unique }),
        );
      });
  }
}

export default BoxDB;
