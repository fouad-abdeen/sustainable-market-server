import {
  Authorized,
  Body,
  Delete,
  Get,
  HeaderParam,
  JsonController,
  Param,
  Post,
  Put,
} from "routing-controllers";
import { BaseService, Context } from "../core";
import { UserRole } from "../models";
import { OpenAPI, ResponseSchema } from "routing-controllers-openapi";
import { ShoppingCartRepository } from "../repositories";
import { ShoppingCartResponse } from "./response";
import { ShoppingCartService } from "../services";
import { CartItemRequest } from "./request";
import { isMongoId } from "class-validator";
import { Service } from "typedi";

@JsonController("/cart")
@Service()
export class ShoppingCartController extends BaseService {
  constructor(
    private _shoppingCartService: ShoppingCartService,
    private _shoppingCartRepository: ShoppingCartRepository
  ) {
    super(__filename);
  }

  // #region Get Cart
  @Authorized({
    roles: [UserRole.CUSTOMER],
    disclaimer: "Only customers can get their shopping cart",
  })
  @HeaderParam("auth")
  @Get("/")
  @OpenAPI({
    summary: "Get shopping cart",
    security: [{ bearerAuth: [] }],
  })
  @ResponseSchema(ShoppingCartResponse)
  async getCart(): Promise<ShoppingCartResponse> {
    const owner = Context.getUser();

    this._logger.info(
      `Received a request to get shopping cart for customer with id: ${owner._id}`
    );

    return ShoppingCartResponse.getCartResponse(
      await this._shoppingCartService.getCart(owner._id as string)
    );
  }
  // #endregion

  // #region Clear Cart
  @Authorized({
    roles: [UserRole.CUSTOMER],
    disclaimer: "Only customers can clear their shopping cart",
  })
  @HeaderParam("auth")
  @Delete("/")
  @OpenAPI({
    summary: "Clear shopping cart",
    security: [{ bearerAuth: [] }],
  })
  async clearCart(): Promise<void> {
    const owner = Context.getUser();

    this._logger.info(
      `Received a request to clear shopping cart for customer with id: ${owner._id}`
    );

    await this._shoppingCartRepository.clearCart(owner._id as string);
  }
  // #endregion

  // #region Add Item
  @Authorized({
    roles: [UserRole.CUSTOMER],
    disclaimer: "Only customers can add items to their shopping cart",
  })
  @HeaderParam("auth")
  @Post("/items")
  @OpenAPI({
    summary: "Add item to shopping cart",
    security: [{ bearerAuth: [] }],
  })
  async addItem(@Body() item: CartItemRequest): Promise<void> {
    const owner = Context.getUser();

    this._logger.info(
      `Received a request to add item with id: ${item.id} to shopping cart for customer with id: ${owner._id}`
    );

    await this._shoppingCartService.addItem(owner._id as string, item);
  }
  // #endregion

  // #region Remove Item
  @Authorized({
    roles: [UserRole.CUSTOMER],
    disclaimer: "Only customers can remove items from their shopping cart",
  })
  @HeaderParam("auth")
  @Delete("/items/:itemId")
  @OpenAPI({
    summary: "Remove item from shopping cart",
    security: [{ bearerAuth: [] }],
  })
  async removeItem(@Param("itemId") itemId: string): Promise<void> {
    const owner = Context.getUser();

    this._logger.info(
      `Received a request to remove item with id: ${itemId} from shopping cart for customer with id: ${owner._id}`
    );

    if (!isMongoId(itemId)) throw new Error("Invalid item id");

    await this._shoppingCartRepository.removeItem(owner._id as string, itemId);
  }
  // #endregion

  // #region Update Item
  @Authorized({
    roles: [UserRole.CUSTOMER],
    disclaimer: "Only customers can update items in their shopping cart",
  })
  @HeaderParam("auth")
  @Put("/items")
  @OpenAPI({
    summary: "Update item in shopping cart",
    security: [{ bearerAuth: [] }],
  })
  async updateItem(@Body() item: CartItemRequest): Promise<void> {
    const owner = Context.getUser();

    this._logger.info(
      `Received a request to update item with id: ${item.id} from shopping cart for customer with id: ${owner._id}`
    );

    await this._shoppingCartService.updateItem(owner._id as string, item);
  }
  // #endregion
}
