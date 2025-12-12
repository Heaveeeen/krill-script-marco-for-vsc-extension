
/** 如果给定参数不属于 T，让 ts 报错 */
export const staticAssert = <T>(x: T) => x;

/** 范围有限的 as 断言 */
export const cast = <T, U extends T>(x: T) => x as U;
