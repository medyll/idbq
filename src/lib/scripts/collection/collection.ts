import { type Where } from "../types.js";
import { Query } from "../query/query.js";
import { idbqlState } from "../state/svelte/idbqlState.svelte.js";
import type { ResultsetOptions, ResultSet } from "../resultSet/resultset.js";
import {
  getWhere,
  type ResultSetWithWhere,
} from "../state/svelte/sttae.svelte.js";

export class Collection<T = any> {
  #store: string;
  private version?: number;
  private dbName;

  private dBOpenRequest!: IDBOpenDBRequest;
  private dBTransaction!: IDBTransaction;

  public dbCollection?: IDBObjectStore;

  private command!: string;
  private keyPath!: string;

  constructor(store: string, dbName: string, version?: number) {
    this.#store = store;
    this.version = version;
    this.dbName = dbName;
  }

  get store() {
    return this.#store;
  }

  /** get the collection */
  private async getCollection(): Promise<IDBObjectStore> {
    return new Promise((resolve, reject) => {
      this.dBOpenRequest = indexedDB.open(
        this.dbName,
        this.version ?? undefined
      );
      this.dBOpenRequest.onsuccess = (event) => {
        const db = event?.target?.result;
        if (!db.objectStoreNames.contains(this.#store)) {
          reject("collection not found");
          return false;
        }
        this.dBTransaction = db.transaction(this.#store, "readwrite");

        this.dbCollection = this.dBTransaction.objectStore(this.#store);

        const command = this.command;
        this.dBTransaction.oncomplete = function (event) {};

        resolve(this.dbCollection);
      };
      this.dBOpenRequest.onerror = () => reject(this.dBOpenRequest.error);
    });
  }

  /**
   * Retrieves the data from the collection based on the provided query.
   * @param qy - The query object specifying the conditions for filtering the data.
   * @param options - The options object specifying additional operations to be applied on the result set.
   * @returns A promise that resolves to the filtered result set.
   * @throws If an error occurs while retrieving the data.
   */
  async where(qy: Where<T>, options?: ResultsetOptions) {
    const data = await this.getAll();
    const query = new Query<T>(data);
    let resultSet = query.where(qy, this.#store);

    if (options) {
      resultSet.setOptions(options);
    }

    return resultSet;

    return await this.getAll()
      .then((data: T[]) => {
        const query = new Query<T>(data);
        let resultSet = query.where(qy, this.#store);

        if (options) {
          resultSet.setOptions(options);
        }

        return resultSet;
      })
      .catch((err) => {
        throw err;
      });
  }

  async update(keyPathValue: string | number, data: Partial<T>) {
    this.command = "update";
    const storeObj = await this.getCollection();
    const keyPath = storeObj?.keyPath;
    this.put({ [keyPath as keyof T]: keyPathValue, ...data });
  }
  async updateWhere(where: Where<T>, data: Partial<T>) {
    this.command = "updateWhere";
    return this.where(where).then(
      (rs: ResultSet<Record<string, any>> | ResultSet<T>) => {
        return new Promise(async (resolve, reject) => {
          const storeObj = await this.getCollection();
          const keyPath = this.dbCollection?.keyPath;
          const id: string | undefined =
            typeof keyPath === "string" ? keyPath : keyPath?.[0];

          [...rs].forEach((dta: T) => {
            if (id && dta[id]) {
              const newData = {
                [keyPath as keyof T]: dta[id],
                ...dta,
                ...data,
              };
              const put = storeObj.put(newData);

              put.onsuccess = () => {
                idbqlState.registerEvent("update", {
                  collection: this.#store,
                  data: newData,
                });
                resolve(true);
              };
            }
          });
        });
      }
    );
  }

  // put data to indexedDB, replace collection content
  async put(value: Partial<T>) {
    this.command = "put";
    const storeObj = await this.getCollection();
    return new Promise((resolve, reject) => {
      const put = storeObj.put(value);
      put.onsuccess = async (event) => {
        //
        const dt = await this.getAll();
        // write to state
        idbqlState.registerEvent("put", {
          collection: this.#store,
          data: dt,
        });
        resolve(put.result);
      };
      put.onerror = function () {
        reject("data not put");
      };
    });
  }

  /** add data to the store */
  async add(data: T): Promise<IDBDatabase> {
    this.command = "add";
    // fire event to collection onsuccess
    const storeObj = await this.getCollection();

    return new Promise(async (resolve, reject) => {
      const add = storeObj.add(data);
      add.onsuccess = async (event) => {
        const updatedData = await this.get(event.target?.result);
        // write to state
        idbqlState.registerEvent("add", {
          collection: this.#store,
          data: updatedData,
        });
        resolve(updatedData);
      };
      add.onerror = function (e) {
        console.log(e);
        resolve(false);
      };
    });
  }

  // get data from indexedDB
  async get(value: any): Promise<T> {
    // this.command = "get";
    const storeObj = await this.getCollection();
    return new Promise((resolve, reject) => {
      const get = storeObj.get(value);
      get.onsuccess = function () {
        resolve(get.result);
      };
      get.onerror = function () {
        reject("not found");
      };
    });
  }

  // get all data from indexedDB
  async getAll(): Promise<T[]> {
    // this.command = "getAll";
    const storeObj = await this.getCollection();
    return new Promise((resolve, reject) => {
      const getAll = storeObj.getAll();
      getAll.onsuccess = function () {
        resolve(getAll.result);
      };
      getAll.onerror = function () {
        reject("not found");
      };
    });
  }

  async delete(keyPathValue: string | number): Promise<boolean> {
    this.command = "delete";
    const storeObj = this.dbCollection ?? (await this.getCollection());
    return new Promise((resolve, reject) => {
      let objectStoreRequest = storeObj.delete(keyPathValue);
      objectStoreRequest.onsuccess = () => {
        // write to state
        idbqlState.registerEvent("delete", {
          collection: this.#store,
          data: keyPathValue,
        });
        resolve(true);
      };
      objectStoreRequest.onerror = function () {
        resolve(false);
      };
    });
  }

  async deleteWhere(where: Where<T>): Promise<boolean> {
    this.command = "deleteWhere";
    return this.where(where).then(
      (data: ResultSet<Record<string, any>> | ResultSet<T>) => {
        return new Promise(async (resolve, reject) => {
          const storeObj = this.dbCollection ?? (await this.getCollection());
          const keyPath = this.dbCollection?.keyPath;
          const id: string | undefined =
            typeof keyPath === "string" ? keyPath : keyPath?.[0];
          [...data].forEach((data: T) => {
            if (id && data[id]) {
              let objectStoreRequest = storeObj.delete(data[id]);
              objectStoreRequest.onsuccess = () => {
                idbqlState.registerEvent("deleteWhere", {
                  collection: this.#store,
                  data: [],
                });
                resolve(true);
              };
            }
          });
        });
      }
    );
  }
}