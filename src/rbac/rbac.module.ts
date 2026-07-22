import { Module } from '@nestjs/common';
import { RbacValidatorService } from './rbac-validator.service';

@Module({
  providers: [RbacValidatorService],
  exports: [RbacValidatorService],
})
export class RbacModule {}
