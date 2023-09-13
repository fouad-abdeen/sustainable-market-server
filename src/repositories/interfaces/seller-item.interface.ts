import { SellerItemQuery } from "../../controllers/request/seller-item.request";
import { SellerItem } from "../../models";

export interface ISellerItemRepository {
  /**
   * Gets a list of items
   * @param conditons conditions to filter items
   */
  getListOfItems(conditions: SellerItemQuery): Promise<SellerItem[]>;

  /**
   * Gets one item by id
   * @param id id of the item
   */
  getItem(id: string): Promise<SellerItem>;

  /**
   * Creates a new item
   * @param item The item to be created
   */
  createItem(item: SellerItem): Promise<SellerItem>;

  /**
   * Updates an existing item
   * @param item The item's data to be updated
   */
  updateItem(item: SellerItem): Promise<SellerItem>;

  /**
   * Deletes an existing item
   * @param id The id of the item to be deleted
   */
  deleteItem(id: string): Promise<void>;
}
