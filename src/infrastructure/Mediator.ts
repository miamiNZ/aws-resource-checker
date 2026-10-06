import { Container, injectable,inject } from "inversify";
import { IHandler } from "../domain/interfaces/IHandler";
import { IMediator } from "../domain/interfaces/IMediator";
import { TYPES } from "./di/types";
import { IRequest } from "../domain/interfaces/IRequest";
import { getHandlerSymbol } from "./di/handlerMapper";
@injectable()
export class Mediator  implements IMediator {
  constructor(@inject(TYPES.Container) private container: Container) {}

  async send<TRequest extends IRequest<TResponse>, TResponse>(
    request: TRequest
  ): Promise<TResponse>
  {
    const handlerSymbol = getHandlerSymbol(request.constructor.name);
    const handler = this.container.get<IHandler<TRequest, TResponse>>(handlerSymbol);
    return handler.handle(request);
  }
}