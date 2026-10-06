import { IRequest } from "./IRequest";

export interface IMediator {
  send<TRequest extends IRequest<TResponse>, TResponse>(request: TRequest): Promise<TResponse>;
}