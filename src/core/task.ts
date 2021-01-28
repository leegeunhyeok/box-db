export enum TaskType {
  ADD = 'add',
  GET = 'get',
  PUT = 'put',
  DELETE = 'delete',
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TaskArguments = any[];

export interface TransactionTask {
  type: TaskType;
  storeName: string;
  args: TaskArguments;
}

/**
 * Rwa values to task
 *
 * @param type
 * @param storeName
 * @param taskArgs
 */
export const toTask = (
  type: TaskType,
  storeName: string,
  taskArgs: TaskArguments,
): TransactionTask => {
  return {
    type,
    storeName,
    args: taskArgs,
  };
};

/**
 * Returns task mapper
 *
 * @param storeName Target object store name
 */
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export const getTaskMapper = (storeName: string) => {
  return {
    add(value, key) {
      return toTask(TaskType.ADD, storeName, [value, key]);
    },
    get(key) {
      return toTask(TaskType.GET, storeName, [key]);
    },
    put(value, key) {
      return toTask(TaskType.PUT, storeName, [value, key]);
    },
    delete(key) {
      return toTask(TaskType.DELETE, storeName, [key]);
    },
  };
};

export default getTaskMapper;