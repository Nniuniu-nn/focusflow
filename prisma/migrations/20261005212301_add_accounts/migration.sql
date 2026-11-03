-- 从匿名身份切换到账号制：User 增加用户名与密码哈希。
--
-- 前提：执行前 User 表必须为空。给非空表加无默认值的 NOT NULL 列，
-- MySQL 会拒绝（严格模式），或者静默填入空串（非严格模式，更危险）。
-- 本项目在改造时按计划先跑了 `prisma migrate reset`，所以这里是干净的 DDL。
--
-- 说明：schema 里 User.id 改成了 @default(uuid())，但那是 Prisma 在**应用层**
-- 生成的默认值，不产生任何 DDL —— 所以这个迁移里看不到 id 的变化。

-- AlterTable
ALTER TABLE `user` ADD COLUMN `passwordHash` VARCHAR(255) NOT NULL,
    ADD COLUMN `username` VARCHAR(32) NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX `User_username_key` ON `User`(`username`);
