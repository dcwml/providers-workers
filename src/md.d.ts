// wrangler rules（Text loader）允许以文本导入 .md 文件，此处补充类型声明
declare module "*.md" {
  const content: string;
  export default content;
}
