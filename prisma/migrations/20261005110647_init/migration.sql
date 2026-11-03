-- CreateTable
CREATE TABLE `User` (
    `id` VARCHAR(64) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Task` (
    `id` VARCHAR(64) NOT NULL,
    `userId` VARCHAR(64) NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `note` TEXT NULL,
    `date` DATE NOT NULL,
    `estimatedPomodoros` INTEGER NOT NULL DEFAULT 1,
    `completedPomodoros` INTEGER NOT NULL DEFAULT 0,
    `status` ENUM('todo', 'doing', 'done') NOT NULL DEFAULT 'todo',
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Task_userId_date_sort_order_idx`(`userId`, `date`, `sort_order`),
    INDEX `Task_userId_status_date_idx`(`userId`, `status`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Session` (
    `id` VARCHAR(64) NOT NULL,
    `userId` VARCHAR(64) NOT NULL,
    `taskId` VARCHAR(64) NULL,
    `clientId` VARCHAR(64) NOT NULL,
    `startAt` DATETIME(3) NOT NULL,
    `endAt` DATETIME(3) NOT NULL,
    `duration` INTEGER NOT NULL,
    `type` ENUM('focus', 'short_break', 'long_break') NOT NULL DEFAULT 'focus',
    `completed` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Session_userId_startAt_idx`(`userId`, `startAt`),
    INDEX `Session_userId_type_startAt_idx`(`userId`, `type`, `startAt`),
    INDEX `Session_taskId_idx`(`taskId`),
    UNIQUE INDEX `Session_userId_clientId_key`(`userId`, `clientId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Setting` (
    `userId` VARCHAR(64) NOT NULL,
    `focusMin` INTEGER NOT NULL DEFAULT 25,
    `shortBreakMin` INTEGER NOT NULL DEFAULT 5,
    `longBreakMin` INTEGER NOT NULL DEFAULT 15,
    `longBreakEvery` INTEGER NOT NULL DEFAULT 4,
    `autoStartNext` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Task` ADD CONSTRAINT `Task_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Session` ADD CONSTRAINT `Session_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Session` ADD CONSTRAINT `Session_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `Task`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Setting` ADD CONSTRAINT `Setting_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
