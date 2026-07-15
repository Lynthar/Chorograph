/* 共用 DOM 取用：外壳各模块按 id 取 index.html 的固定挂点。
   挂点缺失属结构性错误（访问即抛，经全局错误钩子落 #err 红条），故类型上断言存在；
   个别调用点（如 errLine 自身）仍保留运行时判空。 */
export const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
